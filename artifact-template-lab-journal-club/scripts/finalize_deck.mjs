#!/usr/bin/env node
// Finalize an existing builder draft using the currently installed Presentations tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const args = {};
for (let i=2; i<process.argv.length; i+=2) {
  const flag = process.argv[i];
  if (flag === '--help') {
    console.log('node finalize_deck.mjs --manifest BUILD/manifest.json --workspace TASK --output TASK/outputs/name.pptx --presentations-skill DIR --python PATH');
    process.exit(0);
  }
  if (!['--manifest','--workspace','--output','--presentations-skill','--python'].includes(flag) || !process.argv[i+1]) throw new Error('Invalid flag/value: '+flag);
  args[flag.slice(2)] = path.resolve(process.argv[i+1]);
}
for (const key of ['manifest','workspace','output','presentations-skill','python']) if(!args[key]) throw new Error('Missing --'+key);
const manifest = JSON.parse(await fs.readFile(args.manifest,'utf8'));
const source = path.resolve(manifest.draftPath);
if (source === args.output) throw new Error('Final output must differ from the draft');
const validators = path.join(args['presentations-skill'],'container_tools');
const {finalizePresentation} = await import(pathToFileURL(path.join(validators,'artifact_tool_utils.mjs')).href);
const audit = path.join(args.workspace,'work','final-check',path.basename(args.output,'.pptx'));
const tableOwners = manifest.slides.filter(s => s.type === 'comparison').map(s => s.number);
await fs.mkdir(audit,{recursive:true});
await fs.mkdir(path.dirname(args.output),{recursive:true});
const result = await finalizePresentation({
  workspaceDir:args.workspace, candidatePath:source, finalPath:args.output,
  explicitTotalSlideCount:manifest.slideCount,
  requiredNativeTableOwnerSlides:tableOwners, requiredNativeChartOwnerSlides:[],
  pythonExecutable:args.python,
  integrityValidatorPath:path.join(validators,'inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(validators,'inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu',manifest.expectedSlideSizeEmu,'--validate-bullet-geometry','--validate-heading-fit',...tableOwners.flatMap(number => ['--require-native-table-slide',String(number)])],
  fontPolicy:manifest.fontPolicy, verifyArtifactToolImport:true,
  receiptPath:path.join(audit,'validation.json'),
});
const previewDir=path.join(audit,'renders');
execFileSync(process.execPath,[path.join(validators,'render_presentation.mjs'),'--input',args.output,'--output_dir',previewDir,'--scale','1'],{stdio:['ignore','pipe','inherit'],env:process.env,windowsHide:true});
console.log(JSON.stringify({finalPath:args.output,renderDir:previewDir,receiptPath:path.join(audit,'validation.json'),status:'ready-for-visual-inspection'},null,2));
