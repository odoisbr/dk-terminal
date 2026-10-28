// Files outside this explicit application set never enter the distribution.
export const packageIgnores = [
  /^\/(?!(?:dist|electron|extensions|assets|node_modules|package\.json)(?:\/|$))/,
  /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials|id_rsa|id_ed25519|[^/]+\.(?:pem|key))$/i,
  /^\/node_modules\/(?!node-pty(?:\/|$)|node-addon-api(?:\/|$)|yaml(?:\/|$)|@xterm(?:\/|$))/,
  /^\/node_modules\/@xterm\/(?!headless(?:\/|$))/,
];
