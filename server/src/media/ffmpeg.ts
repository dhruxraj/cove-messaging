import { spawn } from 'node:child_process';

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
export interface ProbeResult {
  streams: ProbeStream[];
  format: { format_name?: string; duration?: string; size?: string };
}

function run(bin: string, args: string[], timeoutMs: number, maxOut = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxOut) child.kill('SIGKILL');
      else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited with ${code}: ${err.slice(0, 500)}`));
    });
  });
}

export class Ffmpeg {
  constructor(private ffmpegPath: string, private ffprobePath: string) {}

  async probe(file: string): Promise<ProbeResult> {
    const out = await run(
      this.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-probesize', '20M', '-analyzeduration', '20M', file],
      20_000,
      2 * 1024 * 1024,
    );
    return JSON.parse(out.toString('utf8')) as ProbeResult;
  }

  /** Run ffmpeg with fixed, server-built arguments (user input never reaches the argument list). */
  async exec(args: string[], timeoutMs = 120_000) {
    return run(this.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], timeoutMs);
  }

  /** Extract one frame as PNG bytes. */
  async frame(file: string, atSeconds: number): Promise<Buffer> {
    return run(
      this.ffmpegPath,
      ['-hide_banner', '-nostdin', '-v', 'error', '-ss', atSeconds.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      30_000,
    );
  }
}
