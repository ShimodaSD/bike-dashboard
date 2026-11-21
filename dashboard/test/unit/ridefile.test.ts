// Reading a past ride from a file: .fit (this logger and other devices), .tcx, .gpx and the logger's CSV.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseFit, parseGpx, parseTcx, readRideFile, toRide } from '../../src/import/ridefile';
import { reviewRide } from '../../src/review/review';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../fixtures', name));
const buf = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const FIT_EPOCH = 631065600;

describe('.fit from this logger', () => {
  // 30 min: 15 min at 150 W / 130 bpm, a 30 s pause, then 200 W / 145 bpm (built by build_fit)
  const ride = toRide('ride.fit', parseFit(buf(fixture('ride.fit'))));

  it('reads every second and leaves the pause out', () => {
    expect(ride.hist).toHaveLength(1770);
    expect(ride.start?.toISOString()).toBe('2026-11-15T08:00:00.000Z');
    expect(ride.hist[0]).toMatchObject({ t: 0, power_w: 150, cadence_rpm: 90, heart_rate_bpm: 130, speed_kmh: 30 });
    expect(ride.hist[1769]).toMatchObject({ power_w: 200, heart_rate_bpm: 145 });
    expect(ride.hasPower && ride.hasHr).toBe(true);
  });

  it('adds up distance and energy', () => {
    const last = ride.hist[ride.hist.length - 1];
    expect(last.distance_m).toBeCloseTo(1769 * 30 / 3.6, -1);
    expect(last.energy_kj).toBeCloseTo((900 * 150 + 870 * 200) / 1000, 5);
  });

  it('has no weight (built without one)', () => {
    expect(ride.kg).toBeNull();
  });

  it('gets a review', () => {
    expect(reviewRide({ hist: ride.hist, ftp: 250 }).kind).toBe('Endurance ride');
  });
});

// A small .fit like other devices write: big-endian definition, a developer field, a file_id
// message to skip and a record with a compressed timestamp header.
function otherFit(): ArrayBuffer {
  const b: number[] = [];
  const u8 = (x: number) => b.push(x & 0xff);
  const u16be = (x: number) => { u8(x >> 8); u8(x); };
  const u32be = (x: number) => { u8(x >>> 24); u8(x >>> 16); u8(x >>> 8); u8(x); };
  // file_id (global 0), local 1, little endian: type (enum) only
  u8(0x41); u8(0); u8(0); u8(0); u8(0); u8(1); u8(0); u8(1); u8(0x00);
  u8(0x01); u8(4);
  // user_profile (global 3), local 3, little endian: weight (uint16, 0.1 kg) = 72.5 kg
  u8(0x43); u8(0); u8(0); u8(3); u8(0); u8(1); u8(4); u8(2); u8(0x84);
  u8(0x03); u8(725 & 0xff); u8(725 >> 8);
  // record (global 20), local 0, big endian, with one 2-byte developer field
  u8(0x60); u8(0); u8(1); u16be(20); u8(4);
  u8(253); u8(4); u8(0x86);  u8(7); u8(2); u8(0x84);  u8(3); u8(1); u8(0x02);  u8(73); u8(4); u8(0x86);
  u8(1); u8(0); u8(2); u8(0);
  const ts = 1100000000;
  u8(0x00); u32be(ts); u16be(250); u8(150); u32be(10000); u16be(0xbeef);
  // then records with compressed timestamp headers (+1 s, +2 s): their definition has no timestamp field
  u8(0x42); u8(0); u8(1); u16be(20); u8(2); u8(7); u8(2); u8(0x84); u8(3); u8(1); u8(0x02);
  u8(0x80 | (2 << 5) | ((ts + 1) & 0x1f)); u16be(260); u8(152);
  u8(0x80 | (2 << 5) | ((ts + 2) & 0x1f)); u16be(0xffff); u8(0xff);   // invalid power / hr: no reading
  const data = Uint8Array.from(b);
  const out = new Uint8Array(14 + data.length + 2);
  const v = new DataView(out.buffer);
  v.setUint8(0, 14); v.setUint8(1, 0x20); v.setUint16(2, 2132, true); v.setUint32(4, data.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  out.set(data, 14);
  return out.buffer;
}

describe('.fit from other devices', () => {
  const pts = parseFit(otherFit());
  it('big-endian fields, developer data and compressed timestamps', () => {
    expect(pts[0]).toMatchObject({ t: 1100000000 + FIT_EPOCH, power: 250, hr: 150 });
    expect(pts[0].speed).toBeCloseTo(36, 5);
    expect(pts[1]).toMatchObject({ t: 1100000001 + FIT_EPOCH, power: 260, hr: 152 });
    expect(pts[2]).toMatchObject({ t: 1100000002 + FIT_EPOCH, power: null, hr: null });
  });
  it("the rider's weight from the user profile", () => {
    expect(toRide('x.fit', pts).kg).toBe(72.5);
  });
  it('rejects a file that is not .fit', () => {
    expect(() => parseFit(new TextEncoder().encode('hello world, not fit').buffer as ArrayBuffer)).toThrow('not a .fit file');
  });
});

describe('.tcx', () => {
  const tcx = `<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
 <Activities><Activity Sport="Biking"><Lap><Track>
  <Trackpoint><Time>2026-11-10T18:00:00Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>120</Value></HeartRateBpm><Cadence>85</Cadence>
   <Extensions><ns3:TPX><ns3:Speed>8.5</ns3:Speed><ns3:Watts>180</ns3:Watts></ns3:TPX></Extensions></Trackpoint>
  <Trackpoint><Time>2026-11-10T18:00:03Z</Time><DistanceMeters>25.5</DistanceMeters><HeartRateBpm><Value>122</Value></HeartRateBpm><Cadence>86</Cadence>
   <Extensions><ns3:TPX><ns3:Speed>8.5</ns3:Speed><ns3:Watts>190</ns3:Watts></ns3:TPX></Extensions></Trackpoint>
 </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  it('reads power from the extension and fills 1 s gaps', () => {
    const r = toRide('a.tcx', parseTcx(tcx));
    expect(r.hist.map(s => s.power_w)).toEqual([180, 180, 180, 190]);
    expect(r.hist[3]).toMatchObject({ heart_rate_bpm: 122, cadence_rpm: 86, speed_kmh: 30.6 });
    expect(r.hist[3].distance_m).toBeCloseTo(25.5, 5);
  });
});

describe('.gpx', () => {
  const gpx = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><trkseg>
 <trkpt lat="0" lon="0"><time>2026-11-10T18:00:00Z</time><extensions><power>200</power><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr><gpxtpx:cad>90</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
 <trkpt lat="0" lon="0"><time>2026-11-10T18:00:01Z</time><extensions><power>210</power><gpxtpx:TrackPointExtension><gpxtpx:hr>141</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
</trkseg></trk></gpx>`;
  it('reads power, heart rate and cadence', () => {
    expect(toRide('a.gpx', parseGpx(gpx)).hist.map(s => [s.power_w, s.heart_rate_bpm])).toEqual([[200, 140], [210, 141]]);
  });
  it('broken XML says so', () => {
    expect(() => parseGpx('<gpx><trk>')).toThrow('broken XML');
  });
});

describe('the logger\'s CSV', () => {
  const csv = 't,timestamp_utc,lap,power_w,cadence_rpm,speed_kmh,heart_rate_bpm,distance_m,energy_kj,grade_pct\n' +
    '0,2026-11-10T18:00:00+00:00,1,150,88,29.5,,8.2,0.15,\n1,2026-11-10T18:00:01+00:00,1,160,89,29.8,131,16.5,0.31,';
  it('reads the columns, empty heart rate is no reading', () => {
    const r = toRide('session_1hz.csv', parseCsv(csv));
    expect(r.hist.map(s => [s.power_w, s.heart_rate_bpm])).toEqual([[150, null], [160, 131]]);
    expect(r.hasHr).toBe(true);
  });
  it('the weight_kg column comes along; none or nonsense is no weight', () => {
    expect(toRide('session_1hz.csv', parseCsv(csv)).kg).toBeNull();
    const withKg = csv.split('\n').map((l, i) => l + (i ? ',71.2' : ',weight_kg')).join('\n');
    expect(toRide('session_1hz.csv', parseCsv(withKg)).kg).toBe(71.2);
    expect(toRide('session_1hz.csv', parseCsv(withKg.replaceAll(',71.2', ',7'))).kg).toBeNull();
  });
  it('another CSV is refused', () => {
    expect(() => parseCsv('a,b\n1,2')).toThrow('not a ride from this logger');
  });
});

describe('readRideFile', () => {
  it('reads a File by its extension', async () => {
    const r = await readRideFile(new File([fixture('ride.fit')], 'ride.fit'));
    expect(r.hist).toHaveLength(1770);
  });
  it('an unknown file type', async () => {
    await expect(readRideFile(new File(['x'], 'notes.txt'))).rejects.toThrow('Choose a .fit, .tcx, .gpx or .csv file.');
  });
});
