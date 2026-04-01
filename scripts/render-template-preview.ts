/**
 * Render any registered email template to HTML using its example props.
 *
 * Usage:
 *   npx tsx scripts/render-template-preview.ts <template-id>
 *   npx tsx scripts/render-template-preview.ts --list
 */

import { writeFileSync } from 'fs';

import { render } from '@react-email/render';

import { makeTemplateRegistry } from '../src/modules/email-templates/shell/registry/index.js';

const registry = makeTemplateRegistry();

const templateId = process.argv[2];

if (templateId === undefined || templateId === '--list') {
  const all = registry.getAllShell();
  console.log('Available templates:\n');
  for (const r of all) {
    console.log(`  ${r.id}  — ${r.description}`);
  }
  process.exit(0);
}

const registration = registry.getShell(templateId);

if (registration === undefined) {
  console.error(`Template '${templateId}' not found.`);
  console.error('Run with --list to see available templates.');
  process.exit(1);
}

const main = async () => {
  const element = registration.createElement(registration.exampleProps);
  const html = await render(element, { pretty: true });
  const outPath = `/tmp/${templateId}.html`;
  writeFileSync(outPath, html);
  console.log(`Rendered '${templateId}' -> ${outPath}`);
};

void main();
