/**
 * Embeds capture metadata into the evidence JPEG as standard EXIF so it
 * survives export and is readable by any EXIF tool (exiftool, Windows
 * Properties, Google Photos, court-evidence systems):
 *
 *   0th   : Make/Model/Software, DateTime, ImageDescription (plate | list)
 *   Exif  : DateTimeOriginal/Digitized, OffsetTime*, SubSecTimeOriginal,
 *           UserComment (JSON: full-precision metadata)
 *   GPS   : Latitude/Longitude (≈3 mm rational precision), Altitude,
 *           HPositioningError (accuracy radius), ImgDirection, Speed,
 *           GPSDateStamp/TimeStamp (UTC), MapDatum WGS-84
 */
import piexif from 'piexifjs';
import { toExifDateTime, utcOffset } from './time';
import type { CaptureMeta } from './types';

type Rational = [number, number];

// piexifjs 1.0.6 predates Exif 2.31 offset tags — register them so dump() can encode them.
const EXTRA_EXIF_TAGS: Record<number, { name: string; type: string }> = {
  36880: { name: 'OffsetTime', type: 'Ascii' },
  36881: { name: 'OffsetTimeOriginal', type: 'Ascii' },
  36882: { name: 'OffsetTimeDigitized', type: 'Ascii' },
};
for (const [tag, def] of Object.entries(EXTRA_EXIF_TAGS)) {
  const t = Number(tag);
  if (!piexif.TAGS.Exif[t]) piexif.TAGS.Exif[t] = def;
}

const OFFSET_TIME = 36880;
const OFFSET_TIME_ORIGINAL = 36881;
const OFFSET_TIME_DIGITIZED = 36882;

function rational(value: number, denominator: number): Rational {
  return [Math.round(Math.abs(value) * denominator), denominator];
}

function toDmsRational(decimal: number): [Rational, Rational, Rational] {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [
    [deg, 1],
    [min, 1],
    rational(sec, 10_000),
  ];
}

/** ASCII-only (EXIF Ascii type); strips anything else. */
const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, '?');

export interface EvidenceContext {
  plate: string;
  listName: string;
  listType: string;
  appVersion: string;
}

export function buildExif(meta: CaptureMeta, ctx: EvidenceContext): string {
  const at = new Date(meta.capturedAt);
  const dt = toExifDateTime(meta.capturedAt);
  const offset = utcOffset(at);
  const subsec = String(at.getMilliseconds()).padStart(3, '0');

  const zeroth: Record<number, unknown> = {
    [piexif.ImageIFD.Make]: 'PlateWatch',
    [piexif.ImageIFD.Model]: ascii(meta.userAgent).slice(0, 120),
    [piexif.ImageIFD.Software]: `PlateWatch ${ctx.appVersion}`,
    [piexif.ImageIFD.DateTime]: dt,
    [piexif.ImageIFD.ImageDescription]: ascii(`Plate ${ctx.plate} | ${ctx.listType} list: ${ctx.listName}`),
  };

  const comment = {
    app: 'PlateWatch',
    v: ctx.appVersion,
    plate: ctx.plate,
    payment: meta.payment,
    list: ctx.listName,
    listType: ctx.listType,
    capturedAt: meta.capturedAt,
    capturedAtLocal: meta.capturedAtLocal,
    timeZone: meta.timeZone,
    location: meta.location,
    locationAgeMs: meta.locationAgeMs,
  };

  const exif: Record<number, unknown> = {
    [piexif.ExifIFD.DateTimeOriginal]: dt,
    [piexif.ExifIFD.DateTimeDigitized]: dt,
    [piexif.ExifIFD.SubSecTimeOriginal]: subsec,
    [piexif.ExifIFD.SubSecTimeDigitized]: subsec,
    [OFFSET_TIME]: offset,
    [OFFSET_TIME_ORIGINAL]: offset,
    [OFFSET_TIME_DIGITIZED]: offset,
    [piexif.ExifIFD.UserComment]: 'ASCII\0\0\0' + ascii(JSON.stringify(comment)),
  };

  const gps: Record<number, unknown> = {};
  const fix = meta.location;
  if (fix) {
    const fixDate = new Date(fix.timestamp);
    gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    gps[piexif.GPSIFD.GPSLatitudeRef] = fix.latitude < 0 ? 'S' : 'N';
    gps[piexif.GPSIFD.GPSLatitude] = toDmsRational(fix.latitude);
    gps[piexif.GPSIFD.GPSLongitudeRef] = fix.longitude < 0 ? 'W' : 'E';
    gps[piexif.GPSIFD.GPSLongitude] = toDmsRational(fix.longitude);
    if (fix.altitude !== null && Number.isFinite(fix.altitude)) {
      gps[piexif.GPSIFD.GPSAltitudeRef] = fix.altitude < 0 ? 1 : 0;
      gps[piexif.GPSIFD.GPSAltitude] = rational(fix.altitude, 100);
    }
    gps[piexif.GPSIFD.GPSHPositioningError] = rational(fix.accuracy, 100);
    if (fix.heading !== null) {
      gps[piexif.GPSIFD.GPSImgDirectionRef] = 'T';
      gps[piexif.GPSIFD.GPSImgDirection] = rational(fix.heading, 100);
    }
    if (fix.speed !== null) {
      gps[piexif.GPSIFD.GPSSpeedRef] = 'K';
      gps[piexif.GPSIFD.GPSSpeed] = rational(fix.speed * 3.6, 100);
    }
    gps[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';
    gps[piexif.GPSIFD.GPSDateStamp] =
      `${fixDate.getUTCFullYear()}:${String(fixDate.getUTCMonth() + 1).padStart(2, '0')}:${String(fixDate.getUTCDate()).padStart(2, '0')}`;
    gps[piexif.GPSIFD.GPSTimeStamp] = [
      [fixDate.getUTCHours(), 1],
      [fixDate.getUTCMinutes(), 1],
      rational(fixDate.getUTCSeconds() + fixDate.getUTCMilliseconds() / 1000, 1000),
    ];
  }

  return piexif.dump({ '0th': zeroth, Exif: exif, GPS: gps } as unknown as Parameters<typeof piexif.dump>[0]);
}

/** Insert EXIF into a JPEG data URL; returns a JPEG Blob. */
export function embedExif(jpegDataUrl: string, meta: CaptureMeta, ctx: EvidenceContext): Blob {
  const withExif = piexif.insert(buildExif(meta, ctx), jpegDataUrl);
  return dataUrlToBlob(withExif);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body = ''] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Read back GPS + DateTimeOriginal for display/verification. */
export function readExifSummary(jpegBinaryString: string): {
  dateTimeOriginal?: string;
  offset?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
} {
  const d = piexif.load(jpegBinaryString) as unknown as {
    Exif?: Record<number, unknown>;
    GPS?: Record<number, unknown>;
  };
  const dms = (v: unknown, ref: unknown): number | undefined => {
    if (!Array.isArray(v) || v.length !== 3) return undefined;
    const [dd, mm, ss] = v as Rational[];
    const val = dd![0] / dd![1] + mm![0] / mm![1] / 60 + ss![0] / ss![1] / 3600;
    return ref === 'S' || ref === 'W' ? -val : val;
  };
  const g = d.GPS ?? {};
  const acc = g[piexif.GPSIFD.GPSHPositioningError] as Rational | undefined;
  return {
    dateTimeOriginal: d.Exif?.[piexif.ExifIFD.DateTimeOriginal] as string | undefined,
    offset: d.Exif?.[OFFSET_TIME_ORIGINAL] as string | undefined,
    lat: dms(g[piexif.GPSIFD.GPSLatitude], g[piexif.GPSIFD.GPSLatitudeRef]),
    lng: dms(g[piexif.GPSIFD.GPSLongitude], g[piexif.GPSIFD.GPSLongitudeRef]),
    accuracy: acc ? acc[0] / acc[1] : undefined,
  };
}
