interface BrowserFfmpegModule {
  FS: {
    readFile: (path: string) => Uint8Array;
    writeFile: (path: string, data: Uint8Array) => void;
  };
}

type BrowserFfmpegFactory = (options: Record<string, unknown>) => Promise<BrowserFfmpegModule>;

type BrowserFfmpegRequest = {
  args: string[];
  assetBaseUrl: string;
  id: number;
  inputBuffer: ArrayBuffer;
  inputPath: string;
  moduleUrl: string;
  outputPaths: string[];
};

type BrowserFfmpegResponse =
  | {
      error: string;
      id: number;
      ok: false;
      stderrText: string;
    }
  | {
      exitCode: number;
      files: Array<{ path: string; buffer: ArrayBuffer }>;
      id: number;
      ok: true;
      stderrText: string;
    };

const workerScope = globalThis as typeof globalThis & {
  postMessage: (message: BrowserFfmpegResponse, transfer?: Transferable[]) => void;
};

globalThis.addEventListener("message", (event: MessageEvent<BrowserFfmpegRequest>) => {
  void runFfmpeg(event.data);
});

async function runFfmpeg(request: BrowserFfmpegRequest) {
  const stderr: string[] = [];
  try {
    const imported: unknown = await import(/* @vite-ignore */ request.moduleUrl);
    const factory = resolveFactory(imported);
    let exitCode: number | undefined;
    let resolveExit = (_code: number) => {};
    const exitPromise = new Promise<number>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const module = await factory({
      arguments: request.args,
      locateFile: (name: string) => new URL(name, request.assetBaseUrl).href,
      onExit: (code: number) => {
        exitCode = code;
        resolveExit(code);
      },
      print: () => {},
      printErr: (line: string) => stderr.push(line),
      preRun: (runtimeModule: BrowserFfmpegModule) => {
        runtimeModule.FS.writeFile(request.inputPath, new Uint8Array(request.inputBuffer));
      },
      thisProgram: "ffmpeg",
    });
    const finalExitCode = exitCode ?? (await exitPromise);
    const files =
      finalExitCode === 0
        ? request.outputPaths.map((path) => ({
            path,
            buffer: exactArrayBuffer(module.FS.readFile(path)),
          }))
        : [];
    workerScope.postMessage(
      {
        exitCode: finalExitCode,
        files,
        id: request.id,
        ok: true,
        stderrText: stderr.join("\n"),
      },
      files.map((file) => file.buffer),
    );
  } catch (error) {
    workerScope.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id: request.id,
      ok: false,
      stderrText: stderr.join("\n"),
    });
  }
}

function resolveFactory(imported: unknown): BrowserFfmpegFactory {
  if (typeof imported !== "object" || imported === null || !("default" in imported)) {
    throw new Error("Invalid FFmpeg WebAssembly module");
  }
  const factory: unknown = Reflect.get(imported, "default");
  if (typeof factory !== "function") {
    throw new TypeError("Invalid FFmpeg WebAssembly factory");
  }
  return factory as BrowserFfmpegFactory;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
