import { describe, expect, it } from 'vitest';
import { plateFromLines, type TextLine } from '../src/lib/nativeOcr';

const line = (text: string, x: number, y: number, width: number, height: number): TextLine => ({ text, x, y, width, height });
const image = { width: 1200, height: 400 };

describe('plate from ML Kit lines', () => {
  it('picks the plate over the state slogan and dealer text around it', () => {
    const r = plateFromLines(
      [
        line('CITY MOTORS', 40, 20, 260, 30),
        line('1AB 2CD', 300, 120, 600, 150),
        line('VIC - THE EDUCATION STATE', 350, 300, 500, 30),
      ],
      image,
    );
    expect(r.plate).toBe('1AB2CD');
    expect(r.candidates[0]).toBe('1AB2CD');
    expect(r.rawText).toContain('1AB 2CD');
    expect(r.engine).toBe('mlkit');
  });

  it('prefers the larger plate characters to small text in the middle of the frame', () => {
    const r = plateFromLines([line('NO 55', 560, 190, 80, 20), line('XYZ789', 100, 60, 500, 140)], image);
    expect(r.plate).toBe('XYZ789');
  });

  it('drops the VIC triangle read as X between the groups (field test 1URX6YF)', () => {
    const r = plateFromLines([line('1UR X 6YF', 300, 120, 600, 150), line('VICTORIA - THE EDUCATION STATE', 350, 300, 500, 30)], image);
    expect(r.plate).toBe('1UR6YF');
  });

  it('drops a plate-frame edge read as a leading E (field test EDTS512)', () => {
    expect(plateFromLines([line('EDTS 512', 300, 120, 600, 150)], image).plate).toBe('DTS512');
  });

  it('returns no plate when nothing plate-like was read', () => {
    expect(plateFromLines([], image).plate).toBe('');
    expect(plateFromLines([line('A', 600, 200, 20, 20)], image).plate).toBe('');
  });
});
