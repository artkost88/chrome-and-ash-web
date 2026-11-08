/* Серверная валидация TrackSpec через ТОТ ЖЕ клиентский pure-код.
   Файлы клиента исполняются в изолированном vm-контексте: без require/process/сети,
   без записи в globalThis серверного процесса. */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', '..', 'chrome-and-ash-web', 'js');
const LOAD_ORDER = ['data.js', 'track-gen.js', 'track-editor.js'];

let api = null;

function loadClientApi() {
  if (api) return api;
  const context = vm.createContext({ console });
  for (const file of LOAD_ORDER) {
    const code = fs.readFileSync(path.join(CLIENT_JS, file), 'utf8');
    vm.runInContext(code, context, { filename: 'chrome-and-ash-web/js/' + file });
  }
  const CnA = context.CnA;
  if (!CnA || !CnA.TrackEditor || !CnA.TrackDraft || typeof CnA.validateTrackSpec !== 'function') {
    throw new Error('[cna] не удалось загрузить клиентский TrackSpec-валидатор в VM');
  }
  api = {
    report: CnA.TrackEditor.report,
    prepareSpec: CnA.TrackDraft.prepareSpec,
    cleanName: CnA.TrackEditor.cleanName,
    validateTrackSpec: CnA.validateTrackSpec,
  };
  return api;
}

const client = loadClientApi();

export const report = (spec) => client.report(spec);
export const prepareSpec = (spec) => client.prepareSpec(spec);
export const cleanName = (name) => client.cleanName(name);
export const validateTrackSpec = (spec) => client.validateTrackSpec(spec);

function invalid(code, message) {
  return { ok: false, readOnly: false, issues: [{ code, message }], warnings: [] };
}

/**
 * Строгая серверная проверка для библиотеки: только канонический editable
 * axial TrackSpec v1. Возвращает canonical, который и сохраняется в БД.
 * readOnly/legacy-геометрия и object-decor отклоняются.
 */
export function prepareLibrarySpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return invalid('E_SCHEMA', 'spec должен быть объектом TrackSpec');
  }
  if (spec.schemaVersion !== 1) return invalid('E_SCHEMA', 'поддерживается только TrackSpec schemaVersion 1');
  if (spec.layout !== 'axial') return invalid('E_LAYOUT', 'библиотека принимает только layout=axial');
  if (spec.levels !== 1) return invalid('E_LEVELS', 'поддерживается только levels=1');
  if (!Number.isFinite(spec.hexSize) || spec.hexSize <= 0) return invalid('E_HEXSIZE', 'hexSize должен быть положительным числом');

  const prepared = client.prepareSpec(spec);
  if (!prepared.ok) {
    return { ok: false, readOnly: false, issues: prepared.issues || [], warnings: prepared.warnings || [] };
  }
  if (prepared.readOnly) {
    return invalid('E_READONLY', 'read-only/legacy-геометрия не загружается в библиотеку');
  }
  if (!prepared.canonical) return invalid('E_SCHEMA', 'не удалось получить канонический TrackSpec');
  const check = client.validateTrackSpec(prepared.canonical);
  if (!check.ok) {
    return { ok: false, readOnly: false, issues: check.issues || [], warnings: prepared.warnings || [] };
  }
  return {
    ok: true,
    readOnly: false,
    spec: prepared.canonical,
    warnings: prepared.warnings || [],
  };
}

export const _internals = { LOAD_ORDER, CLIENT_JS };
