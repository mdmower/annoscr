import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

// The binary container behind a .annoscr file: an 8-byte magic, a container
// version, then a sequence of length-prefixed chunks. All integers are unsigned
// little-endian.
//
// The framing knows nothing about what a chunk holds — document.ts defines
// that — so a new payload is a new tag, readers skip tags they don't recognize,
// and a tag may repeat when a document needs several of something.
//
// Length prefixes rather than one parseable blob so a chunk can be reached
// without reading what precedes it: readChunkFromFile answers a preview request
// in a few small reads, seeking past the full-resolution image.

// "ANNOSCR" plus a control byte, so the magic can't begin a plain-text file and
// a transfer that rewrites line endings fails the check.
const MAGIC = new Uint8Array([0x41, 0x4e, 0x4e, 0x4f, 0x53, 0x43, 0x52, 0x1a]);

// Bump only for a change to the FRAMING: the header layout, the chunk header,
// or the byte order. What the chunks mean is versioned separately — see
// DOC_SCHEMA_VERSION in document.ts.
const CONTAINER_VERSION = 1;

const TAG_SIZE = 4;
// magic + u32 container version
const HEADER_SIZE = MAGIC.length + 4;
// tag + u64 payload length
const CHUNK_HEADER_SIZE = TAG_SIZE + 8;

export interface Chunk {
  // Exactly four ASCII characters, e.g. 'IMGE'.
  tag: string;
  data: Uint8Array;
}

// A malformed container: no magic, bad version, truncated chunk, unreadable
// length.
export class ContainerError extends Error {}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Whether these bytes begin a container.
function isContainer(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_SIZE && MAGIC.every((byte, i) => bytes[i] === byte);
}

function checkHeader(header: Uint8Array): void {
  if (!isContainer(header)) throw new ContainerError('missing container magic');
  const version = view(header).getUint32(MAGIC.length, true);
  if (version !== CONTAINER_VERSION) {
    throw new ContainerError(`unsupported container version: ${String(version)}`);
  }
}

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + TAG_SIZE));
}

// A u64 length is more range than a document can use, so anything past the safe
// integer range is corruption rather than a very large chunk.
function readLength(bytes: Uint8Array, offset: number): number {
  const raw = view(bytes).getBigUint64(offset, true);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ContainerError(`chunk length out of range: ${String(raw)}`);
  }
  return Number(raw);
}

export function buildContainer(chunks: ReadonlyArray<Chunk>): Uint8Array {
  let total = HEADER_SIZE;
  for (const chunk of chunks) {
    if (chunk.tag.length !== TAG_SIZE) {
      throw new ContainerError(`chunk tag must be ${String(TAG_SIZE)} characters: ${chunk.tag}`);
    }
    total += CHUNK_HEADER_SIZE + chunk.data.length;
  }

  const out = new Uint8Array(total);
  const dv = view(out);
  out.set(MAGIC, 0);
  dv.setUint32(MAGIC.length, CONTAINER_VERSION, true);

  let offset = HEADER_SIZE;
  for (const chunk of chunks) {
    for (let i = 0; i < TAG_SIZE; i++) out[offset + i] = chunk.tag.charCodeAt(i);
    dv.setBigUint64(offset + TAG_SIZE, BigInt(chunk.data.length), true);
    out.set(chunk.data, offset + CHUNK_HEADER_SIZE);
    offset += CHUNK_HEADER_SIZE + chunk.data.length;
  }
  return out;
}

// Every chunk, in file order. The payloads are views onto the input rather than
// copies, so the caller must keep it alive for as long as it uses them.
export function readContainer(bytes: Uint8Array): Chunk[] {
  checkHeader(bytes);
  const chunks: Chunk[] = [];
  let offset = HEADER_SIZE;
  while (offset < bytes.length) {
    if (offset + CHUNK_HEADER_SIZE > bytes.length) {
      throw new ContainerError('truncated chunk header');
    }
    const tag = readTag(bytes, offset);
    const length = readLength(bytes, offset + TAG_SIZE);
    const start = offset + CHUNK_HEADER_SIZE;
    if (start + length > bytes.length) throw new ContainerError(`chunk ${tag} is truncated`);
    chunks.push({tag, data: bytes.subarray(start, start + length)});
    offset = start + length;
  }
  return chunks;
}

// The first chunk with this tag, or null. A repeated tag is read by filtering
// the list instead.
export function findChunk(chunks: ReadonlyArray<Chunk>, tag: string): Uint8Array | null {
  return chunks.find((chunk) => chunk.tag === tag)?.data ?? null;
}

// ---------- Reading one chunk out of a file ----------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function openRead(file: Gio.File, cancellable: Gio.Cancellable): Promise<Gio.FileInputStream> {
  return new Promise((resolve, reject) => {
    file.read_async(GLib.PRIORITY_LOW, cancellable, (_src, res) => {
      try {
        resolve(file.read_finish(res));
      } catch (e) {
        reject(toError(e));
      }
    });
  });
}

function readBytes(
  stream: Gio.InputStream,
  count: number,
  cancellable: Gio.Cancellable
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    stream.read_bytes_async(count, GLib.PRIORITY_LOW, cancellable, (_src, res) => {
      try {
        resolve(stream.read_bytes_finish(res).get_data() ?? new Uint8Array(0));
      } catch (e) {
        reject(toError(e));
      }
    });
  });
}

// Up to count bytes, short only where the stream ends. A single read may
// return less than it was asked for, so short reads are accumulated. Callers
// check the returned length: whether ending early is a clean end of the file
// or truncation depends on what was being read.
async function readUpTo(
  stream: Gio.InputStream,
  count: number,
  cancellable: Gio.Cancellable
): Promise<Uint8Array> {
  const out = new Uint8Array(count);
  let filled = 0;
  while (filled < count) {
    // eslint-disable-next-line no-await-in-loop -- each read continues where the last stopped
    const part = await readBytes(stream, count - filled, cancellable);
    if (part.length === 0) break;
    out.set(part, filled);
    filled += part.length;
  }
  return out.subarray(0, filled);
}

// The payload of the first chunk with this tag, or null when the file has no
// such chunk. Only the chunk headers and the wanted payload are read; the rest
// is skipped with a seek, which is what keeps a preview cheap in a document
// holding a full-resolution image.
export async function readChunkFromFile(
  file: Gio.File,
  tag: string,
  cancellable: Gio.Cancellable
): Promise<Uint8Array | null> {
  const stream = await openRead(file, cancellable);
  try {
    const header = await readUpTo(stream, HEADER_SIZE, cancellable);
    if (header.length < HEADER_SIZE) {
      throw new ContainerError('file is shorter than a container header');
    }
    checkHeader(header);
    // A regular file always seeks; anything else (a pipe, say) would have to be
    // read through, which defeats the point of asking for one chunk.
    if (!stream.can_seek()) throw new ContainerError('stream does not support seeking');
    // Seeking past the end of a file is legal, so without the file's size a
    // truncated document would seek past the end and report "no such chunk"
    // rather than the corruption it is.
    const size = stream.query_info('standard::size', cancellable).get_size();

    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a chunk's position depends on the one before it
      const chunkHeader = await readUpTo(stream, CHUNK_HEADER_SIZE, cancellable);
      if (chunkHeader.length === 0) return null; // end of the chunk sequence
      // A file that ends partway through a chunk header is truncated, not a
      // shorter sequence.
      if (chunkHeader.length < CHUNK_HEADER_SIZE) {
        throw new ContainerError('truncated chunk header');
      }
      const found = readTag(chunkHeader, 0);
      const length = readLength(chunkHeader, TAG_SIZE);
      if (stream.tell() + length > size) throw new ContainerError(`chunk ${found} is truncated`);
      if (found === tag) {
        // eslint-disable-next-line no-await-in-loop -- the loop ends here
        const data = await readUpTo(stream, length, cancellable);
        if (data.length < length) throw new ContainerError(`chunk ${found} is truncated`);
        return data;
      }
      stream.seek(length, GLib.SeekType.CUR, cancellable);
    }
  } finally {
    // Closed without the cancellable: a cancelled read would fail its own close
    // and hide the error that caused this.
    try {
      stream.close(null);
    } catch {
      // A read-only stream that won't close has nothing left to report.
    }
  }
}
