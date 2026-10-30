// A evidência é autodeclarada; a garantia vem do orquestrador rodar o gate
// e de agentes não gravarem aprovações. Um arquivo pode ser forjado à mão por quem tem acesso ao disco.
// Gate somente de leitura. `concluida` é calculada, nunca lida do estado declarado.
// Uso: node scripts/gate-marco.mjs COORD [--projeto RAIZ] [--json]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { identidade, arquivoEvidencia, lerJson, shaArquivo, contido, caminhoNormalizado, validarPacotes, pacotesVersionados, revisaoAtual, revisaoPacoteConfere, provaCli, hashValido } from './evidencia-marco.mjs';

const preenchido = value => typeof value === 'string' && value.trim().length > 0;
export function verificar(coord, project = process.cwd()) {
  const motivos = [];
  try {
    const projeto = identidade(project), root = projeto.realpath, file = arquivoEvidencia(root, coord);
    if (!fs.existsSync(file)) throw new Error('Evidência de verificação ausente.');
    const e = lerJson(file);
    if (e.schema_version !== 1 || e.coordenacao !== coord) motivos.push('Schema ou coordenação da evidência incompatível.');
    if (e.projeto?.realpath !== root || e.projeto?.dev !== projeto.dev || e.projeto?.ino !== projeto.ino) motivos.push('Evidência pertence a outro projeto (realpath/dev/ino).');
    const runtime = contido(root, `.dk/coordenacoes/${coord}.json`);
    // lstat também detecta links quebrados: somente ENOENT significa estado ausente.
    let runtimeExiste = true;
    try { fs.lstatSync(runtime); } catch (error) { if (error.code === 'ENOENT') runtimeExiste = false; else throw error; }
    if (runtimeExiste) {
      const state = lerJson(runtime), tasks = state.tarefas;
      const values = tasks && typeof tasks === 'object' ? Object.values(tasks) : [];
      const done = task => (task?.estado ?? task?.status) === 'concluido' &&
        (task.estado === undefined || task.estado === 'concluido') && (task.status === undefined || task.status === 'concluido');
      const declared = state.contrato?.tarefas;
      if (state.status !== 'concluido' || state.parado !== false || !values.length || !values.every(done) ||
        (declared !== undefined && (!Array.isArray(declared) || !declared.every(t => done(Array.isArray(tasks) ? tasks.find(v => v.id === t.id) : tasks?.[t.id]))))) {
        motivos.push('Estado runtime da coordenação não está concluído (status, parado ou tarefas).');
      }
    }
    const rev = e.revisao;
    if (!rev || !/^[a-f0-9]{40,64}$/.test(rev.commit || '') || !Array.isArray(rev.dirty) ||
      rev.dirty.some(d => !preenchido(d?.arquivo) || !(d.sha256 === null || hashValido(d.sha256)))) motivos.push('Revisão da evidência inválida.');
    const recorded = new Map();
    if (Array.isArray(rev?.dirty)) for (const d of rev.dirty) {
      try {
        if (caminhoNormalizado(root, d?.arquivo) !== d.arquivo || recorded.has(d.arquivo) || !(d.sha256 === null || hashValido(d.sha256))) throw new Error('registro inválido, não normalizado ou duplicado');
        recorded.set(d.arquivo, d.sha256);
      } catch (error) { motivos.push(`Revisão dirty ${d?.arquivo || '?'}: ${error.message}`); }
    }
    try {
      const current = revisaoAtual(root);
      if (rev?.commit !== current.commit) motivos.push(`Revisão commit divergente de HEAD: registrado=${rev?.commit}, HEAD=${current.commit}.`);
      const actual = new Map(current.dirty.map(d => [d.arquivo, d.sha256]));
      for (const file of [...new Set([...recorded.keys(), ...actual.keys()])].sort()) {
        if (!recorded.has(file)) motivos.push(`Revisão dirty divergente: ${file}: novo no conjunto atual.`);
        else if (!actual.has(file)) motivos.push(`Revisão dirty divergente: ${file}: ausente do conjunto atual.`);
        else if (recorded.get(file) !== actual.get(file)) motivos.push(`Revisão dirty divergente: ${file}: SHA-256 registrado=${recorded.get(file)}, atual=${actual.get(file)}.`);
      }
    } catch (error) { motivos.push(`Revisão Git indisponível: ${error.message}`); }
    const seen = new Set();
    if (!Array.isArray(e.alvos) || !e.alvos.length) motivos.push('Evidência sem alvos verificáveis.');
    else {
      for (const target of e.alvos) {
        try {
          if (!preenchido(target?.arquivo) || !hashValido(target.sha256) || seen.has(target.arquivo)) throw new Error('registro inválido ou duplicado');
          if (caminhoNormalizado(root, target.arquivo) !== target.arquivo) throw new Error('caminho não normalizado');
          seen.add(target.arquivo);
          const file = contido(root, target.arquivo);
          if (target.arquivo.startsWith('.dk/coordenacoes/evidencias/')) throw new Error('evidência usada como alvo');
          if (shaArquivo(file) !== target.sha256) throw new Error('SHA-256 divergente do disco');
        } catch (error) { motivos.push(`Alvo ${target?.arquivo || '?'}: ${error.message}`); }
      }
    }
    try {
      const arquivos = validarPacotes(root, e.pacotes);
      const expected = pacotesVersionados(root, coord);
      const expectedIds = new Set(expected.map(p => p.id));
      for (const p of e.pacotes) if (!expectedIds.has(p.id)) motivos.push(`Pacote extra em evidência, ausente do manifesto de HEAD: ${p.id}`);
      for (const p of expected) {
        const actual = e.pacotes.find(value => value.id === p.id);
        if (!actual) motivos.push(`Pacote do manifesto de HEAD ausente da evidência: ${p.id}`);
        for (const arquivo of p.arquivos) {
          if (actual && !actual.arquivos.includes(arquivo)) motivos.push(`Pacote ${p.id}: arquivo do manifesto de HEAD ausente: ${arquivo}`);
          if (!seen.has(arquivo)) motivos.push(`Arquivo de pacote de HEAD sem cobertura em alvos: ${arquivo}`);
        }
      }
      for (const p of e.pacotes) {
        if (p.revisao.veredito !== 'aprovado') motivos.push(`Pacote ${p.id}: veredito ${p.revisao.veredito}.`);
        if (!revisaoPacoteConfere(p, e.alvos || [])) motivos.push(`Pacote ${p.id}: hashes da revisão divergentes dos alvos atuais.`);
      }
      for (const arquivo of arquivos) if (!seen.has(arquivo)) motivos.push(`Arquivo de pacote sem cobertura em alvos: ${arquivo}`);
    } catch (error) { motivos.push(`Pacotes: ${error.message}`); }
    for (const kind of ['unitarios', 'desktop']) {
      const t = e.testes?.[kind];
      if (!t || t.status !== 'passou' || !Number.isSafeInteger(t.passou) || t.passou <= 0 || t.falhou !== 0 || !preenchido(t.comando) || !hashValido(t.saida_sha256)) motivos.push(`Testes ${kind} sem aprovação válida (comando, contagens e hash da saída).`);
    }
    const decisao = e.decisao_escopo;
    const escopo = preenchido(decisao?.autor) && preenchido(decisao?.data) && preenchido(decisao?.motivo);
    if (!(e.aprovacao_host_provada === true && provaCli(e.cli_oficial)) && !escopo) motivos.push('Rodada manual da CLI oficial não comprovada (P2–P5 devem estar ok) e sem decisão de escopo preenchida.');
  } catch (error) { motivos.push(error.message); }
  return { coordenacao: coord, concluida: motivos.length === 0, motivos };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [coord, ...args] = process.argv.slice(2);
  let project, invalid = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--projeto' && args[i + 1] && !args[i + 1].startsWith('--') && project === undefined) project = args[++i];
    else invalid = true;
  }
  const result = invalid ? { coordenacao: coord, concluida: false, motivos: ['Uso: gate-marco.mjs COORD [--projeto RAIZ] [--json]'] } : verificar(coord, project);
  if (json || !result.concluida) console.log(JSON.stringify(result));
  else console.log(`${coord}: gate liberado.`);
  process.exitCode = result.concluida ? 0 : 1;
}
