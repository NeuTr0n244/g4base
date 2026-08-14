// Sincroniza imóveis do site público (g4-investimoveis) para o G4 (g4base-41f45).
// Só lê do site público, nunca escreve nele. Cria/atualiza contratos completos (9/9) na aba "Contratos" do G4.
// Roda via GitHub Actions a cada 15 minutos (.github/workflows/sync-imoveis.yml), mantendo os dados
// (valor, endereço, fotos, proprietário, data do contrato) sempre espelhados com o site público.

const SITE_PROJECT = 'g4-investimoveis';
const G4_PROJECT = 'g4base-41f45';

const TIPOS_VALIDOS = ['Lote', 'Casa', 'Apartamento', 'Comercial', 'Outro'];

function firestoreUrl(project, path) {
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`;
}

function valorSimples(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  return null;
}

function fieldsToObj(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v.arrayValue !== undefined) out[k] = (v.arrayValue.values || []).map(valorSimples);
    else out[k] = valorSimples(v);
  }
  return out;
}

function objToFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(x => (typeof x === 'boolean' ? { booleanValue: x } : { stringValue: String(x) })) } };
    else fields[k] = { nullValue: null };
  }
  return fields;
}

async function fetchJsonComRetry(url, opts, tentativas = 6) {
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!data.error) return data;
    if (i === tentativas - 1) {
      // Esgotou as tentativas: propaga o erro pra abortar o sync inteiro em vez de seguir com
      // dado incompleto (foi isso que causou duplicatas antes: cota falhava, script achava que
      // não existia contrato nenhum no G4 e recriava tudo do zero).
      throw new Error(`Falha ao acessar Firestore (${url}): ${data.error.message}`);
    }
    console.log(`  ...${data.error.message}, tentando de novo em 15s (tentativa ${i + 1}/${tentativas})`);
    await new Promise(r => setTimeout(r, 15000));
  }
}

async function listAllDocs(project, collection) {
  const docs = [];
  let pageToken = '';
  do {
    const url = firestoreUrl(project, collection) + `?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await fetchJsonComRetry(url);
    // O id do documento (nome real no Firestore) vem por último de propósito: alguns contratos
    // manuais têm um campo interno "id" numérico (timestamp) que, se viesse antes, seria
    // sobrescrito pelo id do documento — mas o inverso (o que queremos) também vale: aqui
    // garantimos que o id do documento sempre prevalece sobre qualquer campo "id" salvo dentro dele.
    (data.documents || []).forEach(d => docs.push({ ...fieldsToObj(d.fields), id: d.name.split('/').pop() }));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

function montarEndereco(p) {
  const partes = [];
  if (p.address) partes.push(p.address + (p.number ? `, nº ${p.number}` : ''));
  if (p.neighborhood) partes.push(p.neighborhood);
  if (p.city) partes.push(`${p.city}/PR`);
  return partes.join(' - ');
}

function mapearTipoImovel(tipo) {
  return TIPOS_VALIDOS.includes(tipo) ? tipo : 'Outro';
}

function mapearTipoNegocio(transaction) {
  if (transaction === 'Aluguel') return 'Locação';
  if (transaction === 'Temporada') return 'Locação';
  return 'Venda';
}

const PLACEHOLDER_PREFIX = 'Aguardando cliente — Ref.';

async function main() {
  console.log('Buscando imóveis ativos no site público...');
  const properties = await listAllDocs(SITE_PROJECT, 'properties');
  const ativos = properties.filter(p => p.active === true);
  console.log(`Imóveis ativos no site público: ${ativos.length}`);

  console.log('Buscando contratos já existentes no G4...');
  const contratosAtuais = await listAllDocs(G4_PROJECT, 'contratos');
  const existentesPorId = {};
  contratosAtuais.forEach(c => { existentesPorId[c.id] = c; });
  // Agrupa por código de referência (qualquer contrato, manual ou sincronizado), pra nunca
  // duplicar um imóvel que a equipe já cadastrou/nomeou manualmente com outro ID de documento.
  const existentesPorRef = {};
  contratosAtuais.forEach(c => {
    if (!c.codigoRef) return;
    (existentesPorRef[c.codigoRef] = existentesPorRef[c.codigoRef] || []).push(c);
  });

  const hojeStr = new Date().toISOString().split('T')[0];

  for (const p of ativos) {
    const contratoId = `site-${p.id}`;
    const existente = existentesPorId[contratoId] || null;

    // Se já existe outro contrato (com ID diferente) pra essa mesma referência e ele já tem
    // nome real (não é placeholder), a equipe já cuidou desse imóvel manualmente — não mexe
    // nele, e apaga a duplicata que o próprio sync criou, se houver.
    if (p.reference) {
      const duplicataManual = (existentesPorRef[p.reference] || [])
        .find(c => c.id !== contratoId && c.cliente && !c.cliente.startsWith(PLACEHOLDER_PREFIX));
      if (duplicataManual) {
        if (existente) {
          await fetch(firestoreUrl(G4_PROJECT, `contratos/${contratoId}`), { method: 'DELETE' });
          console.log(`🗑 Duplicata removida (Ref. ${p.reference}) — já existe contrato manual "${duplicataManual.cliente}"`);
        } else {
          console.log(`↷ Ref. ${p.reference} já tem contrato manual ("${duplicataManual.cliente}") — pulando.`);
        }
        continue;
      }
    }

    // Campos do próprio imóvel: sempre espelham o site público (preço, endereço, foto, tipo).
    const camposImovel = {
      tipo: mapearTipoNegocio(p.transaction),
      tipoImovel: mapearTipoImovel(p.type),
      valor: p.price ? `R$ ${Number(p.price).toLocaleString('pt-BR')}` : '',
      endereco: montarEndereco(p),
      codigoRef: p.reference || '',
      imagemUrl: (p.images && p.images[0]) || '',
    };

    // Cliente: assume o nome do proprietário (`ownerName`) quando o site informar, mas nunca
    // sobrescreve um nome que a equipe já tenha digitado manualmente aqui no G4.
    const clienteAtual = existente ? existente.cliente : null;
    const clienteEhPlaceholder = !clienteAtual || clienteAtual.startsWith(PLACEHOLDER_PREFIX);
    const cliente = clienteEhPlaceholder ? (p.ownerName || `${PLACEHOLDER_PREFIX} ${p.reference || p.id}`) : clienteAtual;

    // Data de início: quando o site público tem `contractDate`, ela sempre espelha esse valor
    // (inclusive quando for corrigida lá depois). Sem `contractDate`, mantém a data que já foi
    // definida na criação (evita ficar "hoje" toda hora, já que não tem data real pra usar).
    const dataInicio = p.contractDate || (existente && existente.dataInicio) || hojeStr;
    let dataVencimento;
    if (existente && existente.dataInicio === dataInicio && existente.dataVencimento) {
      dataVencimento = existente.dataVencimento;
    } else {
      const v = new Date(dataInicio + 'T00:00:00');
      v.setMonth(v.getMonth() + 24);
      dataVencimento = v.toISOString().split('T')[0];
    }

    const mudou = !existente
      || camposImovel.tipo !== existente.tipo
      || camposImovel.tipoImovel !== existente.tipoImovel
      || camposImovel.valor !== existente.valor
      || camposImovel.endereco !== existente.endereco
      || camposImovel.codigoRef !== existente.codigoRef
      || camposImovel.imagemUrl !== existente.imagemUrl
      || cliente !== clienteAtual
      || dataInicio !== existente.dataInicio;

    if (!mudou) {
      console.log(`= Sem mudanças: ${cliente} (${camposImovel.endereco})`);
      continue;
    }

    // Parte de (existente || {}) pra preservar qualquer outro campo que a equipe já tenha
    // definido no G4 (status, checklist, última visita, localização, manutenção, etc.) — o
    // PATCH do Firestore sem updateMask substitui o documento inteiro, então precisamos
    // reenviar tudo que já estava lá, não só os campos que o sync conhece.
    const contrato = {
      ...(existente || {}),
      id: contratoId,
      ...camposImovel,
      cliente,
      dataInicio,
      dataVencimento,
      status: (existente && existente.status) || 'ativo',
      // Checklist entra completo (9/9) na criação, pra cair direto na aba "Contratos" — depois
      // disso fica por conta da equipe marcar/desmarcar itens.
      checklist: (existente && existente.checklist) || [true, true, true, true, true, true, true, true, true],
      // Imóvel está ativo no site público agora — garante que a tag de "Inativo" seja removida
      // caso tenha sido pausado e reativado depois.
      inativoNoSite: false,
    };

    const url = firestoreUrl(G4_PROJECT, `contratos/${contratoId}`);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: objToFields(contrato) }),
    });
    if (res.ok) {
      console.log(`✓ Sincronizado: ${contrato.cliente} (${contrato.endereco})`);
    } else {
      console.error(`✗ Falha ao sincronizar ${contratoId}:`, await res.text());
    }
  }

  // Imóvel que ficou INATIVO no site (mas ainda existe lá, só pausado) não é removido — só
  // ganha uma tag "Inativo" aqui, pra equipe saber que ele saiu do ar sem perder o contrato.
  const inativos = properties.filter(p => p.active === false);
  for (const p of inativos) {
    const contratoId = `site-${p.id}`;
    const existente = existentesPorId[contratoId] || null;
    if (!existente || existente.inativoNoSite === true) continue; // não existe aqui, ou já marcado
    const contrato = { ...existente, id: contratoId, inativoNoSite: true };
    const res = await fetch(firestoreUrl(G4_PROJECT, `contratos/${contratoId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: objToFields(contrato) }),
    });
    if (res.ok) {
      console.log(`⏸ Marcado como inativo no site: ${existente.cliente} (${existente.endereco})`);
    } else {
      console.error(`✗ Falha ao marcar inativo ${contratoId}:`, await res.text());
    }
  }

  // Remove contratos sincronizados cujo imóvel foi removido de vez do site público (não existe
  // mais lá, nem como inativo) — só quando ainda estiverem no placeholder. Se a equipe já
  // digitou um nome real, protege e mantém (pode ser uma venda já concretizada).
  const idsNoSite = new Set(properties.map(p => `site-${p.id}`));
  const orfaos = contratosAtuais.filter(c => c.id.startsWith('site-') && !idsNoSite.has(c.id));
  for (const c of orfaos) {
    if (c.cliente && !c.cliente.startsWith(PLACEHOLDER_PREFIX)) {
      console.log(`⚠ ${c.id} não existe mais no site, mas já tem nome real ("${c.cliente}") — mantendo.`);
      continue;
    }
    const res = await fetch(firestoreUrl(G4_PROJECT, `contratos/${c.id}`), { method: 'DELETE' });
    if (res.ok) {
      console.log(`🗑 Removido (saiu do site): ${c.cliente || c.id} (${c.endereco || ''})`);
    } else {
      console.error(`✗ Falha ao remover ${c.id}:`, await res.text());
    }
  }
}

main().catch(e => {
  console.error('Erro no sync:', e);
  process.exit(1);
});
