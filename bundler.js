import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import glob from 'fast-glob';
// https://github.com/mrmlnc/fast-glob#pattern-syntax
import slash from 'slash';
import cssnano from 'cssnano';
import postcss from 'postcss';
import { minify as minifyJs } from 'terser';
import { optimize as minifySvg } from 'svgo';

if (process.argv.length < 4) {
  console.error(`Usage: bin-bundler <assetDirectory> <htmlGlob> (gzipLevel)`);
  process.exit(1);
}

const [, , assetDirectory, htmlGlob] = process.argv;
const gzipLevel = parseInt(process.argv[4], 10);

const htmlPaths = await glob(slash(htmlGlob), { onlyFiles: true });

if (htmlPaths.length === 0) {
  throw new Error('Found 0 HTML file.');
}

function escapeRegEx(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cssMinifier = postcss([cssnano({ preset: 'advanced' })]);

const matchers = {
  js: [
    /<script.*src="([\w/.-]+)"/gi,
    (file, from) => minifyJs({ [from]: file.toString() }, { sourceMap: false }).then(({ code }) => code),
  ],
  css: [
    /<link.*(?:rel="?stylesheet"?.*href="([\w/.-]+)"|href="([\w/.-]+)".*rel="?stylesheet"?)/gi,
    (file, from) => cssMinifier.process(file.toString(), { map: false, from }).then(({ css }) => css),
  ],
  svg: [/<img.*src="([\w/.-]+\.svg)"/gi, (file) => minifySvg(file.toString()).data],
  // other: [/<link.*href="([\w/.-]+\.ico)"/gi, (file) => file],
};

const htmlFiles = {};
const changes = Object.fromEntries(Object.keys(matchers).map((key) => [key, {}]));

const assetRegEx = new RegExp(`^/${escapeRegEx(basename(assetDirectory))}`);

for (const path of htmlPaths) {
  const file = await readFile(path, 'utf8');
  htmlFiles[path] = [file, false];

  for (const kind in changes) {
    const matcher = matchers[kind];
    for (const [, _match, match = _match] of file.matchAll(matcher[0])) {
      const target = changes[kind];
      if (match in target) {
        target[match].push(path);
      } else {
        try {
          const from = join(assetDirectory, match.replace(assetRegEx, ''));
          target[match] = [await matcher[1](await readFile(from), from), from, path];
        } catch (error) {
          console.error(`At ${path} for ${kind.toUpperCase()} files : ${match}.`);
          throw error;
        }
      }
    }
  }
}

for (const change in changes) {
  for (const path in changes[change]) {
    let [content, from, ...htmlPaths] = changes[change][path];

    if (gzipLevel) {
      content = gzipSync(content, { level: gzipLevel });
    }

    const hash = createHash('md5').update(content).digest('hex');
    const ext = extname(from) + (gzipLevel ? '.gz' : '');
    const dest = join(dirname(from), `${hash}${ext}`);

    // minifiable things
    // if (gzipLevel || typeof content === 'string') {
    await writeFile(dest, content);
    await unlink(from);
    // } else {
    //   await rename(from, dest);
    // }

    const pathRegEx = new RegExp(`"${escapeRegEx(path)}"`, 'g');
    const newPath = `"${slash(join(dirname(path), `${hash}${ext}`))}"`;
    for (const htmlPath of htmlPaths) {
      htmlFiles[htmlPath][0] = htmlFiles[htmlPath][0].replace(pathRegEx, newPath);
      // changed
      htmlFiles[htmlPath][1] = true;
    }
  }
}

for (const htmlPath in htmlFiles) {
  let [content, changed] = htmlFiles[htmlPath];
  if (changed) {
    await writeFile(htmlPath, content);
  }
}

console.log('Successfully bundled bin assets.');
