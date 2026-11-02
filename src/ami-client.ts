import net from 'net';
import { getSecret } from './env-store';
import { ViciConfig } from './types';

export interface AmiActionResult {
  ok: boolean;
  response: string;
  message: string;
  raw: string;
}

/**
 * Lightweight Asterisk Manager Interface (AMI) TCP client (:5038)
 * Used for connectivity diagnostics, non-Remote-Agent channel Redirect transfers,
 * and channel Hangup fallback on co-located ViciBox deployments.
 */
export class AsteriskAmiClient {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly secretOverride?: string;

  constructor(cfg: ViciConfig, secretOverride?: string) {
    this.host = cfg.amiHost || '115.186.137.240';
    this.port = Number(cfg.amiPort || 5038);
    this.username = cfg.amiUser || 'cron';
    this.secretOverride = secretOverride;
  }

  private get secret(): string {
    return this.secretOverride !== undefined ? this.secretOverride : getSecret('AMI_SECRET');
  }

  async executeAction(
    actionName: string,
    fields: Record<string, string | number> = {},
    timeoutMs = 3500
  ): Promise<AmiActionResult> {
    if (!this.secret) {
      return {
        ok: false,
        response: 'MissingSecret',
        message: 'AMI_SECRET is not configured in server .env',
        raw: '',
      };
    }

    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';
      let loggedIn = false;
      let bannerSeen = false;

      const finish = (res: AmiActionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.end('Action: Logoff\r\n\r\n');
          socket.destroy();
        } catch {}
        resolve(res);
      };

      const socket = net.createConnection({ host: this.host, port: this.port });

      const timer = setTimeout(() => {
        finish({
          ok: false,
          response: 'Timeout',
          message: `Timed out connecting/authenticating to Asterisk AMI at ${this.host}:${this.port}`,
          raw: buffer.slice(0, 300),
        });
      }, timeoutMs);

      const sendFrame = (lines: string[]) => {
        socket.write(lines.join('\r\n') + '\r\n\r\n');
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        if (!bannerSeen && buffer.includes('\r\n')) {
          bannerSeen = true;
          // Strip initial "Asterisk Call Manager/x.y.z\r\n" greeting line
          const nlIdx = buffer.indexOf('\r\n');
          buffer = buffer.slice(nlIdx + 2);
          sendFrame([
            'Action: Login',
            `Username: ${this.username}`,
            `Secret: ${this.secret}`,
            'Events: off',
          ]);
        }

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\r\n\r\n')) !== -1) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 4);

          const map: Record<string, string> = {};
          for (const line of block.split('\r\n')) {
            const cIdx = line.indexOf(':');
            if (cIdx > 0) {
              const k = line.slice(0, cIdx).trim().toLowerCase();
              const v = line.slice(cIdx + 1).trim();
              map[k] = v;
            }
          }

          if (!loggedIn && map.response) {
            if (map.response.toLowerCase() === 'success') {
              loggedIn = true;
              if (actionName.toLowerCase() === 'login') {
                finish({
                  ok: true,
                  response: map.response,
                  message: map.message || 'Authentication accepted',
                  raw: block,
                });
                return;
              }
              const actionLines = [`Action: ${actionName}`];
              for (const [k, v] of Object.entries(fields)) {
                actionLines.push(`${k}: ${v}`);
              }
              sendFrame(actionLines);
            } else {
              finish({
                ok: false,
                response: map.response,
                message: map.message || 'AMI Login failed',
                raw: block,
              });
              return;
            }
          } else if (loggedIn && map.response) {
            finish({
              ok: map.response.toLowerCase() === 'success',
              response: map.response,
              message: map.message || '',
              raw: block,
            });
            return;
          }
        }
      });

      socket.on('error', (err) => {
        finish({
          ok: false,
          response: 'SocketError',
          message: `AMI TCP error (${this.host}:${this.port}): ${err.message}`,
          raw: '',
        });
      });

      socket.on('close', () => {
        if (!settled) {
          finish({
            ok: false,
            response: 'Closed',
            message: 'AMI socket closed unexpectedly',
            raw: buffer.slice(0, 300),
          });
        }
      });
    });
  }

  async ping(): Promise<AmiActionResult> {
    return this.executeAction('Ping');
  }

  async redirectChannel(opts: {
    channel: string;
    exten: string;
    context?: string;
    priority?: number;
  }): Promise<AmiActionResult> {
    return this.executeAction('Redirect', {
      Channel: opts.channel,
      Exten: opts.exten,
      Context: opts.context || 'default',
      Priority: opts.priority || 1,
    });
  }

  async hangupChannel(channel: string): Promise<AmiActionResult> {
    return this.executeAction('Hangup', { Channel: channel });
  }
}
