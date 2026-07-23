export interface Args {
  port?: number;
  noTelegram: boolean;
  help: boolean;
  version: boolean;
}

/** Parse the CLI flags. Unknown flags are ignored (forward-compatible). */
export function parseArgs(argv: string[]): Args {
  const a: Args = { noTelegram: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") a.port = Number(argv[++i]);
    else if (arg === "--no-telegram") a.noTelegram = true;
    else if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--version" || arg === "-v") a.version = true;
  }
  return a;
}
