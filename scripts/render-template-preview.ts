/**
 * Render any registered email template to HTML/text without sending email.
 *
 * Usage:
 *   npx tsx scripts/render-template-preview.ts <template-id>
 *   npx tsx scripts/render-template-preview.ts <template-id> --props-file=/tmp/props.json
 *   npx tsx scripts/render-template-preview.ts <template-id> --props-file=/tmp/props.json --output-dir=/tmp/rendered-email
 *   npx tsx scripts/render-template-preview.ts --list
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fromThrowable } from 'neverthrow';
import pinoLogger from 'pino';

import { makeTemplateRegistry } from '../src/modules/email-templates/shell/registry/index.js';
import { makeEmailRenderer } from '../src/modules/email-templates/shell/renderer/index.js';

import type { EmailTemplateProps } from '../src/modules/email-templates/core/types.js';

const registry = makeTemplateRegistry();
const parseJson = fromThrowable(JSON.parse);

const templateId = process.argv[2];
const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

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

const EmailTemplatePropsFileSchema = Type.Object({
  templateType: Type.String({ minLength: 1 }),
});

const loadProps = async (): Promise<EmailTemplateProps> => {
  const propsFile = getArgValue('--props-file');
  if (propsFile === undefined || propsFile.trim() === '') {
    return registration.exampleProps;
  }

  const raw = await readFile(propsFile, 'utf8');
  const parsed = parseJson(raw);
  if (parsed.isErr()) {
    const message = parsed.error instanceof Error ? parsed.error.message : String(parsed.error);
    throw new Error(`Failed to parse props JSON '${propsFile}': ${message}`);
  }

  const value = parsed.value as unknown;
  if (!Value.Check(EmailTemplatePropsFileSchema, value)) {
    throw new Error(`Props JSON '${propsFile}' must contain a string templateType`);
  }

  if (value.templateType !== templateId) {
    throw new Error(
      `Props JSON templateType '${value.templateType}' does not match requested template '${templateId}'`
    );
  }

  return value as EmailTemplateProps;
};

const main = async () => {
  const props = await loadProps();
  const outputDir = getArgValue('--output-dir') ?? `/tmp/${templateId}`;
  const logger = pinoLogger({ level: process.env['LOG_LEVEL'] ?? 'silent' });
  const renderer = makeEmailRenderer({ logger });
  const rendered = await renderer.render(props);

  if (rendered.isErr()) {
    throw new Error(`${rendered.error.type}: ${rendered.error.message}`);
  }

  await mkdir(outputDir, { recursive: true });

  const htmlPath = path.join(outputDir, 'index.html');
  const textPath = path.join(outputDir, 'index.txt');
  const metaPath = path.join(outputDir, 'meta.json');

  await writeFile(htmlPath, rendered.value.html, 'utf8');
  await writeFile(textPath, rendered.value.text, 'utf8');
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        templateType: props.templateType,
        subject: rendered.value.subject,
        templateName: rendered.value.templateName,
        templateVersion: rendered.value.templateVersion,
        htmlPath,
        textPath,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        templateType: props.templateType,
        subject: rendered.value.subject,
        htmlPath,
        textPath,
        metaPath,
      },
      null,
      2
    )
  );
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
