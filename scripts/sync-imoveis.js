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

function fieldsToObj(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.arrayValue !== undefined) out[k] = (v.arrayValue.values || []).map(x => x.stringValue ?? x);
    else out[k] = null;
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

async function listAllDocs(project, collection) {
  const docs = [];
  let pageToken = '';
  do {
    const url = firestoreUrl(project, collection) + `?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    (data.documents || []).forEach(d => docs.push({ id: d.name.split('/').pop(), ...fieldsToObj(d.fields) }));
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

async function main() {
  console.log('Buscando imóveis ativos no site público...');
  const properties = await listAllDocs(SITE_PROJECT, 'properties');
  const novos = properties.filter(p => p.active === true);
  console.log(`Imóveis ativos no site público: ${novos.length}`);

  if (novos.length === 0) {
    console.log('Nada novo para sincronizar.');
    return;
  }

  for (const p of novos) {
    const contratoId = `site-${p.id}`;
    const hoje = new Date();
    // dataInicio vem da data do contrato informada no site público (campo `contractDate`),
    // com fallback para a data em que o sync rodou, caso o imóvel ainda não tenha esse campo.
    const dataInicioStr = p.contractDate || hoje.toISOString().split('T')[0];
    const vencimento = new Date(dataInicioStr + 'T00:00:00');
    vencimento.setMonth(vencimento.getMonth() + 12);
    const contrato = {
      id: contratoId,
      // cliente vem do nome do proprietário informado no site público (campo `ownerName`),
      // com fallback para o placeholder antigo caso o imóvel ainda não tenha esse campo.
      cliente: p.ownerName || `Aguardando cliente — Ref. ${p.reference || p.id}`,
      tipo: mapearTipoNegocio(p.transaction),
      tipoImovel: mapearTipoImovel(p.type),
      valor: p.price ? `R$ ${Number(p.price).toLocaleString('pt-BR')}` : '',
      endereco: montarEndereco(p),
      codigoRef: p.reference || '',
      imagemUrl: (p.images && p.images[0]) || '',
      dataInicio: dataInicioStr,
      dataVencimento: vencimento.toISOString().split('T')[0],
      status: 'ativo',
      // Checklist já entra completo (9/9) para o contrato cair direto na aba "Contratos", não em "Em Andamento".
      checklist: [true, true, true, true, true, true, true, true, true],
      ultimaVisita: '',
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
}

main().catch(e => {
  console.error('Erro no sync:', e);
  process.exit(1);
});
