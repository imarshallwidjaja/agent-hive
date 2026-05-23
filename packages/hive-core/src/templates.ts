// Skill templates for remaining Hive runtime surfaces.
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'skills');

export function getSkillTemplate(name: string): string {
  const templatePath = path.join(TEMPLATES_DIR, `${name}.md`);
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8');
  }
  throw new Error(`Template not found: ${name}`);
}

export function getAllSkillNames(): string[] {
  return ['hive'];
}
