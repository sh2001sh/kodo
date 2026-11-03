// Held-out acceptance check for data-01-stats-chart.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when:
//   - deliverables/chart.png is missing, is not a real PNG, or is smaller than 600x400;
//   - deliverables/report.md is missing, is not 200-300 Chinese characters (+/-10%),
//     or does not name the top region (华东).
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const problems = [];

const readText = relative => {
  const target = path.join(root, ...relative.split('/'));
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
};

// 1) chart.png must be a genuine PNG with sane dimensions.
const chartFile = path.join(root, 'deliverables', 'chart.png');
let dims = null;
if (!fs.existsSync(chartFile)) {
  problems.push('missing deliverables/chart.png');
} else {
  const buffer = fs.readFileSync(chartFile);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    problems.push('chart.png is not a PNG image (bad signature)');
  } else if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    problems.push('chart.png is missing the IHDR chunk');
  } else if (!buffer.includes(Buffer.from('IDAT', 'ascii'))) {
    problems.push('chart.png has no IDAT image data');
  } else if (buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') !== 'IEND') {
    problems.push('chart.png does not end with the PNG IEND chunk (corrupted or non-image bytes appended)');
  } else {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    dims = { width, height, bytes: buffer.length };
    if (width < 600 || height < 400) {
      problems.push(`chart.png is too small: ${width}x${height} (need width >= 600 and height >= 400)`);
    }
  }
}

// 2) report.md: 200-300 Chinese characters (+/-10% tolerance) and top region named.
const report = readText('deliverables/report.md');
if (report === null) {
  problems.push('missing deliverables/report.md');
} else {
  const cjk = (report.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  if (cjk < 190 || cjk > 330) {
    problems.push(`report.md has ${cjk} Chinese characters (expected 200-300, tolerance +/-10%)`);
  }
  if (!report.includes('华东')) {
    problems.push('report.md does not name the top region 华东');
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-chart: OK (${dims.width}x${dims.height}, ${dims.bytes} bytes)`);
