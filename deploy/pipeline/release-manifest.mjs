/** 只验证本环境显式声明的架构及文件；不扫描历史遗留目录。 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hashFile } from './digest.mjs';

export function releasePaths(ctx) {
  const spec = ctx.profile.stages.package;
  if (!spec.architectures?.length || !spec.releaseDirectory) throw new Error('打包阶段缺少架构或发布目录声明');
  const directory = path.resolve(ctx.root, spec.releaseDirectory.replaceAll('{env}', ctx.env));
  return {
    directory,
    manifests: spec.architectures.map(arch => path.join(directory, `release-manifest-${arch}.json`)),
    merged: path.join(directory, 'release-manifest.json'),
  };
}

export function validateRelease(ctx) {
  const { directory, manifests, merged } = releasePaths(ctx);
  const architectures = ctx.profile.stages.package.architectures;
  const files = [...manifests, merged];
  const read = file => {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.schema !== 1 || !ctx.git.commit || manifest.commit !== ctx.git.commit
      || manifest.tag !== `deploy-${ctx.git.commit}` || manifest.repository !== (ctx.git.repository ?? 'hxx344/project-aggregation')) {
      throw new Error(`发布清单身份与当前提交不一致：${file}`);
    }
    return manifest;
  };
  let combined;
  for (const [index, file] of manifests.entries()) {
    const manifest = read(file);
    const key = `linux-${architectures[index]}`;
    if (!isDeepStrictEqual(Object.keys(manifest.artifacts ?? {}), [key])) throw new Error(`打包清单架构不一致：${file}`);
    const artifact = manifest.artifacts[key];
    if (typeof artifact.file !== 'string' || !artifact.file || /[/\\]/.test(artifact.file)
      || artifact.file === '.' || artifact.file === '..' || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
      throw new Error(`发布包路径或 SHA-256 无效：${file}`);
    }
    const artifactPath = path.join(directory, artifact.file);
    if (path.dirname(realpathSync(artifactPath)) !== realpathSync(directory) || !statSync(artifactPath).isFile()
      || hashFile(artifactPath) !== artifact.sha256) throw new Error(`发布包缺失、越界或摘要不一致：${artifactPath}`);
    files.push(artifactPath);
    const { artifacts, ...identity } = manifest;
    if (!combined) combined = { ...identity, artifacts: {} };
    const { artifacts: previous, ...previousIdentity } = combined;
    if (!isDeepStrictEqual(identity, previousIdentity)) throw new Error('不同架构的发布身份不一致');
    Object.assign(previous, artifacts);
  }
  if (!isDeepStrictEqual(read(merged), combined)) throw new Error('合并清单与本次架构清单不一致');
  return files;
}
