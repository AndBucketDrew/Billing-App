/**
 * MsalAuthService — wraps @azure/msal-node for Electron desktop login.
 *
 * Setup (one-time, per developer):
 *   1. Register an app in https://portal.azure.com → Azure Active Directory → App Registrations
 *   2. Set platform to "Mobile and desktop applications"
 *   3. Add redirect URI: http://localhost  (MSAL picks the port automatically)
 *   4. Add API permissions: Microsoft Graph → Delegated → Mail.Read, offline_access
 *   5. Copy the Application (client) ID into OUTLOOK_CLIENT_ID env var or hardcode below
 *
 * Token security:
 *   Tokens are serialised via MSAL's built-in cache, then encrypted with
 *   Electron's safeStorage (OS keychain / DPAPI / libsecret) before writing
 *   to disk. They never cross the IPC bridge to the renderer.
 */

import {
  PublicClientApplication,
  AccountInfo,
  AuthenticationResult,
  TokenCacheContext,
  Configuration,
} from '@azure/msal-node';
import { safeStorage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// ─── Scopes ──────────────────────────────────────────────────────────────────

export const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'offline_access',
];

// ─── Service ─────────────────────────────────────────────────────────────────

export class MsalAuthService {
  private pca: PublicClientApplication;
  private readonly cacheFile: string;

  constructor(userDataPath: string, clientId: string) {
    this.cacheFile = path.join(userDataPath, '.outlook_cache.enc');

    const config: Configuration = {
      auth: {
        clientId,
        // 'common' allows both personal and work/school accounts.
        // Replace with your tenant ID to restrict to one organisation.
        authority: 'https://login.microsoftonline.com/common',
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (ctx: TokenCacheContext) => {
            if (!fs.existsSync(this.cacheFile)) return;
            try {
              const encrypted = fs.readFileSync(this.cacheFile);
              if (safeStorage.isEncryptionAvailable()) {
                ctx.tokenCache.deserialize(safeStorage.decryptString(encrypted));
              }
            } catch {
              // Corrupted cache — ignore, fresh login will recreate it
            }
          },
          afterCacheAccess: async (ctx: TokenCacheContext) => {
            if (!ctx.cacheHasChanged) return;
            if (safeStorage.isEncryptionAvailable()) {
              const encrypted = safeStorage.encryptString(ctx.tokenCache.serialize());
              fs.writeFileSync(this.cacheFile, encrypted);
            }
          },
        },
      },
    };

    this.pca = new PublicClientApplication(config);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Opens the system browser for interactive OAuth2 login.
   * MSAL spins up a loopback HTTP server and handles the redirect automatically.
   */
  async login(): Promise<{ name: string; username: string }> {
    const result: AuthenticationResult = await (this.pca as any).acquireTokenInteractive({
      scopes: GRAPH_SCOPES,
      openBrowser: async (url: string) => shell.openExternal(url),
      successTemplate: successHtml,
      errorTemplate: errorHtml,
    });

    return this.accountToDto(result.account!);
  }

  /** Clears the encrypted token cache and signs the user out. */
  async logout(): Promise<void> {
    if (fs.existsSync(this.cacheFile)) {
      fs.unlinkSync(this.cacheFile);
    }
  }

  /**
   * Returns a valid access token, refreshing silently if possible.
   * Falls back to interactive login if the refresh token is expired.
   * Throws 'NOT_AUTHENTICATED' if no account exists at all.
   */
  async getAccessToken(): Promise<string> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) throw new Error('NOT_AUTHENTICATED');

    try {
      const result = await this.pca.acquireTokenSilent({
        scopes: GRAPH_SCOPES,
        account: accounts[0],
      });
      return result!.accessToken;
    } catch {
      // Silent refresh failed (e.g. refresh token expired) — re-authenticate
      await this.login();
      const fresh = await this.pca.getTokenCache().getAllAccounts();
      const result = await this.pca.acquireTokenSilent({
        scopes: GRAPH_SCOPES,
        account: fresh[0],
      });
      return result!.accessToken;
    }
  }

  /** Returns the cached account without network I/O. Returns null if not logged in. */
  async getLoggedInAccount(): Promise<{ name: string; username: string } | null> {
    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    return this.accountToDto(accounts[0]);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private accountToDto(account: AccountInfo): { name: string; username: string } {
    return {
      name: account.name || account.username || 'Unknown',
      username: account.username || '',
    };
  }
}

// ─── Login page HTML (shown in system browser) ────────────────────────────────

const successHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;
  text-align:center;padding:60px;background:#f5f5f5">
  <div style="background:#fff;padding:40px;border-radius:8px;display:inline-block;
    box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <h1 style="color:#4caf50">&#10003; Login Successful</h1>
    <p>You can close this window and return to Tour Billing.</p>
  </div></body></html>`;

const errorHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;
  text-align:center;padding:60px;background:#f5f5f5">
  <div style="background:#fff;padding:40px;border-radius:8px;display:inline-block;
    box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <h1 style="color:#f44336">&#10007; Login Failed</h1>
    <p>{error}</p>
  </div></body></html>`;
