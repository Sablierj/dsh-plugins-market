/**
 * DSH 插件市场索引 —— format 1 校验器（纯 JS，无依赖）。
 *
 * 规则逐条对应 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index/lib/index.js`：
 * DSH 读索引时用的是**那份**实现，不是这一份。这里只是让仓库在没有 DSH 的机器上
 * （CI、另一台电脑）也能自查，所以规则必须跟着上游走；上游改规则时请同步本文件，
 * 并抬头看一遍对应版本的 README。
 *
 * 与上游的差别只有两处，都是为了给出更好的报错：
 *   1. 上游遇到第一条违规就抛异常，这里收集**全部**违规再返回。
 *   2. 上游丢弃未定义的成员，这里额外记一条 warning（避免「写了却静默失效」）。
 */

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
);
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;

const PLUGIN_KEYS = new Set(['name', 'title', 'description', 'icon', 'author', 'homepage', 'repository', 'metadata', 'versions']);
const VERSION_KEYS = new Set(['version', 'publishTimestamp', 'source', 'engines']);

class Sink {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  fail(path, reason) {
    this.errors.push(`${path} ${reason}`);
  }

  warn(path, note) {
    this.warnings.push(`${path} ${note}`);
  }

  /** 未定义成员：上游会丢弃，这里只提醒。 */
  extraKeys(object, allowed, path) {
    for (const key of Object.keys(object)) {
      if (!allowed.has(key)) this.warn(`${path}.${key}`, 'is not part of format 1 and will be dropped by DSH');
    }
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function objectAt(sink, value, path) {
  if (!isObject(value)) {
    sink.fail(path, 'must be an object');
    return undefined;
  }
  return value;
}

function stringAt(sink, value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    sink.fail(path, 'must be a string with a non-whitespace character');
    return undefined;
  }
  return value;
}

function localizedText(sink, value, path) {
  if (typeof value === 'string') return stringAt(sink, value, path);
  if (!isObject(value)) {
    sink.fail(path, 'must be a string or an object keyed by language id');
    return undefined;
  }
  let sawEn = false;
  for (const [language, member] of Object.entries(value)) {
    if (!LANGUAGE_ID.test(language)) sink.fail(`${path}.${language}`, 'must be keyed by a lowercase language id');
    if (language === 'en') sawEn = true;
    stringAt(sink, member, `${path}.${language}`);
  }
  if (!sawEn) sink.fail(path, 'must contain en');
  return value;
}

function declarations(sink, value, path, read) {
  const result = {};
  if (value === undefined) return result;
  if (!isObject(value)) {
    sink.fail(path, 'must be an object');
    return result;
  }
  for (const [id, member] of Object.entries(value)) {
    if (id === '') sink.fail(path, 'must not declare an empty id');
    const object = objectAt(sink, member, `${path}.${id}`);
    if (object === undefined) continue;
    result[id] = read(object, `${path}.${id}`);
  }
  return result;
}

function declaredId(sink, value, path, declared) {
  const id = stringAt(sink, value, path);
  if (id === undefined) return undefined;
  if (!Object.hasOwn(declared, id)) sink.fail(path, `references undeclared id ${JSON.stringify(id)}`);
  return id;
}

function httpUrl(sink, value, path, protocols) {
  const text = stringAt(sink, value, path);
  if (text === undefined) return undefined;
  let url;
  try {
    url = new URL(text);
  } catch {
    sink.fail(path, 'must be an absolute URL');
    return undefined;
  }
  if (!protocols.includes(url.protocol)) sink.fail(path, `must use ${protocols.join(' or ')}`);
  if (url.username !== '' || url.password !== '') sink.fail(path, 'must not contain credentials');
  if (url.href.includes('?') || url.href.includes('#')) sink.fail(path, 'must not contain a query or fragment');
  return url.href;
}

function homepageUrl(sink, value, path) {
  const text = stringAt(sink, value, path);
  if (text === undefined) return undefined;
  let url;
  try {
    url = new URL(text);
  } catch {
    sink.fail(path, 'must be an absolute URL');
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') sink.fail(path, 'must use https: or http:');
  return url.href;
}

function gitUrl(sink, value, path) {
  const href = httpUrl(sink, value, path, ['https:']);
  if (href === undefined) return undefined;
  if (href !== value) sink.fail(path, 'must be a canonical URL');
  const url = new URL(href);
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) sink.fail(path, 'must name a repository with at least two path segments');
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) sink.fail(path, 'must name a repository, not a tarball');
  return href;
}

function packagePath(sink, value, path) {
  const text = stringAt(sink, value, path);
  if (text === undefined) return undefined;
  if (text.split('/').some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    sink.fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..');
  }
  return text;
}

function source(sink, value, path) {
  const object = objectAt(sink, value, path);
  if (object === undefined) return undefined;
  if (object.type === 'npm') {
    const registry = object.registry === undefined ? undefined : httpUrl(sink, object.registry, `${path}.registry`, ['https:', 'http:']);
    return registry === undefined ? { type: 'npm' } : { type: 'npm', registry };
  }
  if (object.type === 'git') {
    const commit = stringAt(sink, object.commit, `${path}.commit`);
    if (commit !== undefined && !COMMIT.test(commit)) {
      sink.fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA');
    }
    const url = gitUrl(sink, object.url, `${path}.url`);
    const dir = object.path === undefined ? undefined : packagePath(sink, object.path, `${path}.path`);
    return dir === undefined ? { type: 'git', url, commit } : { type: 'git', url, commit, path: dir };
  }
  sink.fail(`${path}.type`, 'must be "npm" or "git"');
  return undefined;
}

function engines(sink, value, path) {
  const object = objectAt(sink, value, path);
  if (object === undefined) return {};
  const dsh = object.dsh;
  if (dsh === undefined) return {};
  const range = stringAt(sink, dsh, `${path}.dsh`);
  if (range === undefined) return {};
  if (range.startsWith('workspace:')) sink.fail(`${path}.dsh`, 'must not be a workspace: range');
  return { dsh: range };
}

function icon(sink, value, path, indexUrl) {
  const text = stringAt(sink, value, path);
  if (text === undefined) return undefined;
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1];
    if (payload === undefined || payload === '' || !BASE64.test(payload)) {
      sink.fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL');
      return text;
    }
    const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    if (bytes > MAX_INLINE_ICON_BYTES) sink.fail(path, `must not exceed ${MAX_INLINE_ICON_BYTES / 1024} KiB of decoded bytes`);
    return text;
  }
  let resolved;
  try {
    resolved = new URL(text, indexUrl);
  } catch {
    sink.fail(path, 'must be a URL reference');
    return text;
  }
  const base = new URL(indexUrl);
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== base.origin)) {
    sink.fail(path, 'must resolve to https or the index origin');
  }
  return resolved.href;
}

function marketVersion(sink, value, path) {
  const object = objectAt(sink, value, path);
  if (object === undefined) return undefined;
  sink.extraKeys(object, VERSION_KEYS, path);
  const version = stringAt(sink, object.version, `${path}.version`);
  if (version !== undefined && !SEMVER.test(version)) sink.fail(`${path}.version`, 'must be an exact SemVer version');
  const ts = object.publishTimestamp;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0 || ts >= MAX_PUBLISH_TIMESTAMP) {
    sink.fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)');
  }
  const from = source(sink, object.source, `${path}.source`);
  const engine = object.engines === undefined ? {} : engines(sink, object.engines, `${path}.engines`);
  return { version, publishTimestamp: ts, source: from, engines: engine };
}

function versions(sink, value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    sink.fail(path, 'must be a non-empty array');
    return [];
  }
  const seen = new Set();
  return value.map((member, position) => {
    const at = `${path}[${String(position)}]`;
    const entry = marketVersion(sink, member, at);
    if (entry?.version !== undefined) {
      if (seen.has(entry.version)) sink.fail(`${at}.version`, `duplicates ${entry.version}`);
      seen.add(entry.version);
    }
    return entry;
  });
}

function pluginMetadata(sink, value, path, index) {
  if (value === undefined) return { keywords: [], labels: [], sortKeys: {} };
  const object = objectAt(sink, value, path);
  if (object === undefined) return { keywords: [], labels: [], sortKeys: {} };
  const result = { keywords: [], labels: [], sortKeys: {} };
  if (object.category !== undefined) result.category = declaredId(sink, object.category, `${path}.category`, index.categories);
  if (object.keywords !== undefined) {
    if (!Array.isArray(object.keywords)) sink.fail(`${path}.keywords`, 'must be an array');
    else
      result.keywords = object.keywords.map((keyword, position) => {
        if (typeof keyword !== 'string') sink.fail(`${path}.keywords[${String(position)}]`, 'must be a string');
        return keyword;
      });
  }
  if (object.labels !== undefined) {
    if (!Array.isArray(object.labels)) sink.fail(`${path}.labels`, 'must be an array');
    else {
      const ids = object.labels.map((label, position) => declaredId(sink, label, `${path}.labels[${String(position)}]`, index.labels));
      if (new Set(ids).size !== ids.length) sink.fail(`${path}.labels`, 'must not repeat a label');
      result.labels = ids;
    }
  }
  if (object.sortKeys !== undefined) {
    const keys = objectAt(sink, object.sortKeys, `${path}.sortKeys`);
    if (keys !== undefined) {
      for (const [id, sortValue] of Object.entries(keys)) {
        declaredId(sink, id, `${path}.sortKeys.${id}`, index.sortKeys);
        if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) {
          sink.fail(`${path}.sortKeys.${id}`, 'must be a finite number');
        }
        result.sortKeys[id] = sortValue;
      }
    }
  }
  return result;
}

function plugin(sink, value, path, index, indexUrl) {
  const object = objectAt(sink, value, path);
  if (object === undefined) return undefined;
  sink.extraKeys(object, PLUGIN_KEYS, path);
  const name = stringAt(sink, object.name, `${path}.name`);
  if (name !== undefined && (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name))) {
    sink.fail(`${path}.name`, 'must be a valid npm package name');
  }
  const result = { name };
  if (object.title !== undefined) result.title = localizedText(sink, object.title, `${path}.title`);
  if (object.description !== undefined) result.description = localizedText(sink, object.description, `${path}.description`);
  if (object.icon !== undefined) result.icon = icon(sink, object.icon, `${path}.icon`, indexUrl);
  if (object.author !== undefined) result.author = stringAt(sink, object.author, `${path}.author`);
  if (object.homepage !== undefined) result.homepage = homepageUrl(sink, object.homepage, `${path}.homepage`);
  if (object.repository !== undefined) {
    const repo = objectAt(sink, object.repository, `${path}.repository`);
    if (repo !== undefined) {
      result.repository = { url: httpUrl(sink, repo.url, `${path}.repository.url`, ['https:', 'http:']) };
      if (repo.directory !== undefined) result.repository.directory = packagePath(sink, repo.directory, `${path}.repository.directory`);
    }
  }
  result.metadata = pluginMetadata(sink, object.metadata, `${path}.metadata`, index);
  result.versions = versions(sink, object.versions, `${path}.versions`);
  return result;
}

/**
 * 校验一份索引文档。
 * @param {unknown} doc 已解析的 JSON
 * @param {string} indexUrl 该文档所在 URL（相对图标按它解析；也是 DSH 要求的「非重定向最终 URL」）
 * @returns {{ errors: string[], warnings: string[], index: object | undefined }}
 */
export function validateIndex(doc, indexUrl) {
  const sink = new Sink();
  let base;
  try {
    base = new URL(indexUrl);
  } catch {
    sink.fail('$', `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`);
    return { errors: sink.errors, warnings: sink.warnings, index: undefined };
  }
  const object = objectAt(sink, doc, '$');
  if (object === undefined) return { errors: sink.errors, warnings: sink.warnings, index: undefined };
  if (object.format !== 1) sink.fail('$.format', 'must be 1');

  const metadataIn = object.metadata === undefined ? {} : objectAt(sink, object.metadata, '$.metadata');
  const metadata = { categories: {}, labels: {}, sortKeys: {} };
  if (metadataIn !== undefined) {
    metadata.categories = declarations(sink, metadataIn.categories, '$.metadata.categories', (member, at) => ({
      title: localizedText(sink, member.title, `${at}.title`),
    }));
    metadata.labels = declarations(sink, metadataIn.labels, '$.metadata.labels', (member, at) => ({
      title: localizedText(sink, member.title, `${at}.title`),
    }));
    metadata.sortKeys = declarations(sink, metadataIn.sortKeys, '$.metadata.sortKeys', (member, at) => {
      if (member.order !== 'asc' && member.order !== 'desc') sink.fail(`${at}.order`, 'must be "asc" or "desc"');
      return { title: localizedText(sink, member.title, `${at}.title`), order: member.order };
    });
  }

  if (!Array.isArray(object.plugins)) {
    sink.fail('$.plugins', 'must be an array');
    return { errors: sink.errors, warnings: sink.warnings, index: undefined };
  }
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(sink, entry, `$.plugins[${String(position)}]`, metadata, base);
    if (parsed?.name !== undefined) {
      if (names.has(parsed.name)) sink.fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`);
      names.add(parsed.name);
    }
    return parsed;
  });

  const title = localizedText(sink, object.title, '$.title');
  const description = object.description === undefined ? undefined : localizedText(sink, object.description, '$.description');
  const index = { format: 1, title, description, metadata, plugins };
  return { errors: sink.errors, warnings: sink.warnings, index };
}

/**
 * 一个版本对应的安装参数，与 DSH 的 marketInstallTarget 同规则：
 * npm 为 `name@version`；git 为 `git+<url>.git#<commit>`，包在子目录时追加 `&path:/<path>`。
 */
export function marketInstallTarget(name, version) {
  const from = version.source;
  if (from?.type === 'npm') {
    return from.registry === undefined ? { spec: `${name}@${version.version}` } : { spec: `${name}@${version.version}`, registry: from.registry };
  }
  if (from?.type === 'git') {
    const base = from.url.endsWith('.git') ? from.url : `${from.url}.git`;
    const suffix = from.path === undefined ? '' : `&path:/${from.path}`;
    return { spec: `git+${base}#${from.commit}${suffix}` };
  }
  return { spec: undefined };
}
