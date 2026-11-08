import { parseArgs } from 'node:util';
import { deploy } from './deploy/index.ts';
import { pull } from './pull.ts';
import { api, CliError, platformUrl, repoName } from './util.ts';

const USAGE = `mastra-platform <command>

  start [--port 4200] [--home ~/.mastra-platform]   run the platform
  deploy [--repo name]                             build and upload this repo's agents, workflows and steps
  pull [--check] [--target web] [--out file]       write a typed api for other repos' units
                                                   (src/mastra/_generated/api.ts; web: src/_generated/api.ts)
  rollback <unit> <version>                        point prod at an earlier version
  secrets set KEY=VALUE…  |  secrets list          per-repo env for this repo's threads

  --url defaults to $MASTRA_PLATFORM_URL or http://localhost:4200`;

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      repo: { type: 'string' },
      port: { type: 'string' },
      home: { type: 'string' },
      check: { type: 'boolean' },
      target: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const url = platformUrl(values.url);
  const cwd = process.cwd();

  try {
    switch (cmd) {
      case 'start': {
        const { startPlatform } = await import('@mastra/platform');
        const p = await startPlatform({ port: values.port ? Number(values.port) : undefined, home: values.home });
        console.log(`platform listening on ${p.url}  (home ${p.home})`);
        console.log(`  dashboard  ${p.url}/_dashboard`);
        const stop = async () => {
          await p.close();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return;
      }
      case 'deploy':
        return await deploy(cwd, { url, repo: await repoName(cwd, values.repo) });
      case 'pull':
        return await pull(cwd, { url, check: values.check, target: values.target, out: values.out, repo: await repoName(cwd, values.repo) });
      case 'rollback': {
        const [unit, version] = positionals;
        if (!unit || !version) throw new CliError('usage: mastra-platform rollback <unit> <version>');
        const r = await api(url, `/_platform/units/${encodeURIComponent(unit)}/tags/prod`, { method: 'PUT', json: { version } });
        console.log(`  ${unit}  prod  v${r.from} → v${r.version}`);
        return;
      }
      case 'secrets': {
        const repo = await repoName(cwd, values.repo);
        const [sub, ...pairs] = positionals;
        if (sub === 'set') {
          const values: Record<string, string> = {};
          for (const p of pairs) {
            const i = p.indexOf('=');
            if (i < 1) throw new CliError(`expected KEY=VALUE, got ${p}`);
            values[p.slice(0, i)] = p.slice(i + 1);
          }
          const r = await api(url, `/_platform/repos/${repo}/secrets`, { method: 'PUT', json: values });
          console.log(`  ${repo} secrets: ${r.keys.join(', ')}`);
        } else if (sub === 'list' || !sub) {
          const r = await api(url, `/_platform/repos/${repo}/secrets`);
          console.log(r.keys.length ? r.keys.map((k: string) => `  ${k}`).join('\n') : '  (none)');
        } else throw new CliError('usage: mastra-platform secrets set KEY=VALUE…');
        return;
      }
      default:
        console.log(USAGE);
        if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
