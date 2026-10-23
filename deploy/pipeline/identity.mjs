/** 只从已配置的 GitHub origin 取得发布身份，不把任意 URL 或凭据写入日志。 */
export function parseGithubRepository(origin) {
  let repository;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(origin);
  if (scp) repository = scp[1];
  else {
    try {
      const url = new URL(origin);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com'
        || url.port || url.search || url.hash) return null;
      repository = url.pathname.slice(1);
    } catch { return null; }
  }
  repository = repository.replace(/\.git$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
    && !['.', '..'].includes(repository.split('/')[1]) ? repository : null;
}

export function publicationEnvironment(git, env) {
  if (!git.repository || !/^[a-f0-9]{40}$/.test(git.commit)) throw new Error('无法从 origin 与当前提交确定发布身份，拒绝发布');
  const verified = { GITHUB_REPOSITORY: git.repository, GITHUB_SHA: git.commit };
  for (const [name, value] of Object.entries(verified)) {
    if (env[name] !== undefined && env[name] !== value) throw new Error(`${name} 与流水线 Git 身份不一致，拒绝发布`);
  }
  return verified;
}
