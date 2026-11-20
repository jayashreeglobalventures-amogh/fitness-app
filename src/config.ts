// Runtime configuration from the environment. Secrets never reach the browser, the database or the logs.
export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  publicOrigin: string; // e.g. https://fitness.amogh.systems - used for the same-origin (CSRF) check
  mediaDir: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  backupStatusFile?: string; // written by deploy/backup.sh; reported by /healthz
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    databaseUrl: need('DATABASE_URL'),
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    publicOrigin: need('PUBLIC_ORIGIN').replace(/\/$/, ''),
    mediaDir: need('MEDIA_DIR'),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
    backupStatusFile: env.BACKUP_STATUS_FILE || undefined,
  };
}
