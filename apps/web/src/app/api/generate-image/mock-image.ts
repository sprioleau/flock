import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio } from "./constants";

/**
 * Deterministic mock image generator — the image-pipeline analogue of the chat
 * route's mock model (CI/tests never need a key; dev works without image
 * quota). Encodes a REAL PNG (vertical two-color gradient, colors derived from
 * a hash of the prompt) so every downstream step — data-URI preview, binary
 * upload to Convex storage, <img> rendering — exercises genuine image bytes.
 * Pure function of (prompt, aspectRatio); no I/O.
 */

const MOCK_IMAGE_WIDTH = 600;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- CRC32 (the PNG chunk checksum) -----------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, tableIndex) => {
  let crc = tableIndex;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePngChunk(chunkType: string, data: Buffer): Buffer {
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(chunkType, "ascii"), data]);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([lengthBytes, typeAndData, crcBytes]);
}

// --- Prompt → deterministic gradient colors ----------------------------------

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/** Convert a hue (0-360) at fixed saturation/lightness to RGB — muted but distinct. */
function hueToRgb(hue: number): RgbColor {
  const saturation = 0.55;
  const lightness = 0.62;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = lightness - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const components = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ][sector]!;
  return {
    red: Math.round((components[0]! + base) * 255),
    green: Math.round((components[1]! + base) * 255),
    blue: Math.round((components[2]! + base) * 255),
  };
}

// --- The generator ------------------------------------------------------------

export interface CreateMockImageInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
}

export interface MockImageResult {
  base64: string;
  mimeType: "image/png";
}

/** Height for a 600px-wide image at the given aspect ratio. */
function resolveMockImageHeight(aspectRatio: ImageAspectRatio): number {
  const [ratioWidth = 1, ratioHeight = 1] = aspectRatio.split(":").map(Number);
  return Math.round((MOCK_IMAGE_WIDTH * ratioHeight) / ratioWidth);
}

export function createMockImagePng({ prompt, aspectRatio = "4:3" }: CreateMockImageInput): MockImageResult {
  if (!IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`createMockImagePng: unsupported aspect ratio "${aspectRatio}".`);
  }
  const width = MOCK_IMAGE_WIDTH;
  const height = resolveMockImageHeight(aspectRatio);

  const promptDigest = createHash("sha256").update(prompt).digest();
  const topColor = hueToRgb((promptDigest[0]! * 360) / 256);
  const bottomColor = hueToRgb((promptDigest[1]! * 360) / 256);

  // Raw scanlines: filter byte 0 + RGB per pixel; rows blend top → bottom.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    raw[offset] = 0;
    offset += 1;
    const blend = height === 1 ? 0 : row / (height - 1);
    const red = Math.round(topColor.red + (bottomColor.red - topColor.red) * blend);
    const green = Math.round(topColor.green + (bottomColor.green - topColor.green) * blend);
    const blue = Math.round(topColor.blue + (bottomColor.blue - topColor.blue) * blend);
    for (let column = 0; column < width; column += 1) {
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    PNG_SIGNATURE,
    encodePngChunk("IHDR", ihdr),
    encodePngChunk("IDAT", deflateSync(raw)),
    encodePngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { base64: png.toString("base64"), mimeType: "image/png" };
}
