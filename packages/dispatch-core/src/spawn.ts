export type SpawnInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

function quoteForCmd(arg: string): string {
  if (!/[\s"&()^<>|]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function buildSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env['COMSPEC'] || 'cmd.exe',
): SpawnInvocation {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: comspec,
      args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
      shell: false,
    };
  }

  return {
    command,
    args,
    shell: false,
  };
}
