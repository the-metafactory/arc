import { chmod, mkdir, writeFile } from "fs/promises";
import { join } from "path";

export interface FakeSomaOptions {
  root: string;
  shimDir?: string;
  callsFile?: string;
  scriptForCallsPath: (callsPath: string) => string;
}

export async function installFakeSoma(opts: FakeSomaOptions) {
  const callsPath = join(opts.root, opts.callsFile ?? "soma-calls.log");
  const somaPath = join(opts.shimDir ?? opts.root, "soma");
  const originalSomaBin = process.env.ARC_SOMA_BIN;

  await mkdir(opts.shimDir ?? opts.root, { recursive: true });
  await writeFile(somaPath, opts.scriptForCallsPath(callsPath));
  await chmod(somaPath, 0o755);
  process.env.ARC_SOMA_BIN = somaPath;

  return {
    callsPath,
    somaPath,
    restore() {
      if (originalSomaBin === undefined) {
        delete process.env.ARC_SOMA_BIN;
      } else {
        process.env.ARC_SOMA_BIN = originalSomaBin;
      }
    },
  };
}
