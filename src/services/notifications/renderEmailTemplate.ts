import fs from 'fs';
import path from 'path';
import Handlebars, { TemplateDelegate } from 'handlebars';
import type { ConsolidatedEmailData } from './emailTypes';
import { formatCurrency as formatCurrencyRO } from '../../utils/formatter';

// Cache compiled templates by absolute path
const templateCache = new Map<string, TemplateDelegate<ConsolidatedEmailData & { year: number }>>();
let partialsRegistered = false;

function resolveTemplatesDir(): string {
  const candidates = [
    // When running via ts-node during development
    path.resolve(__dirname, '../../templates/email'),
    // Fallback to project root (useful when CWD is project root)
    path.resolve(process.cwd(), 'src/templates/email'),
    // When running compiled code from dist
    path.resolve(__dirname, '../../../templates/email'),
    path.resolve(process.cwd(), 'dist/src/templates/email'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Last resort: return first candidate; compile will throw a clearer error later
  return candidates[0];
}

function registerHelpersOnce() {
  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

  Handlebars.registerHelper('formatCurrency', (value: number | string, notationArg?: unknown) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return '';

    // In Handlebars, the last argument is the options object; when only one
    // parameter is provided, notationArg will be that options object.
    const notation = typeof notationArg === 'string' ? (notationArg as 'standard' | 'compact') : undefined;
    return formatCurrencyRO(num, notation);
  });
}

function registerPartialsOnce(templatesDir: string) {
  const partialsDir = path.join(templatesDir, 'partials');
  if (!fs.existsSync(partialsDir)) return;

  const files = fs.readdirSync(partialsDir).filter((f) => f.endsWith('.hbs'));
  for (const file of files) {
    const name = path.basename(file, '.hbs');
    const content = fs.readFileSync(path.join(partialsDir, file), 'utf8');
    Handlebars.registerPartial(name, content);
  }
}

function getCompiledTemplate(
  templatesDir: string,
  templateName: string
): TemplateDelegate<ConsolidatedEmailData & { year: number }> {
  const filePath = path.join(templatesDir, `${templateName}.hbs`);
  if (templateCache.has(filePath)) return templateCache.get(filePath)!;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Email template not found: ${filePath}`);
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const tpl = Handlebars.compile<ConsolidatedEmailData & { year: number }>(source);
  templateCache.set(filePath, tpl);
  return tpl;
}

export async function renderEmailTemplate(
  templateName: 'consolidated-notification',
  data: ConsolidatedEmailData
): Promise<string> {
  const templatesDir = resolveTemplatesDir();

  if (!partialsRegistered) {
    registerHelpersOnce();
    registerPartialsOnce(templatesDir);
    partialsRegistered = true;
  }

  const template = getCompiledTemplate(templatesDir, templateName);

  const context: ConsolidatedEmailData & { year: number } = {
    ...data,
    year: new Date().getFullYear(),
  };

  return template(context);
}

export default renderEmailTemplate;
