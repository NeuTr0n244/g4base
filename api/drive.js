// Ponte com o Google Drive: guarda uma autorização única e permanente (variáveis de
// ambiente no Vercel), então NENHUM usuário do site precisa fazer login no Google —
// funciona em qualquer aparelho, direto.
//
// Variáveis de ambiente necessárias (configurar no painel do Vercel):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Falha ao renovar token do Google: ' + JSON.stringify(data));
  return data.access_token;
}

async function acharOuCriarPasta(accessToken, nome, paiId) {
  const nomeEscapado = nome.replace(/'/g, "\\'");
  const q = encodeURIComponent(`name='${nomeEscapado}' and mimeType='application/vnd.google-apps.folder' and '${paiId}' in parents and trashed=false`);
  const buscaRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const busca = await buscaRes.json();
  if (busca.files && busca.files.length > 0) return busca.files[0].id;
  const criarRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nome, mimeType: 'application/vnd.google-apps.folder', parents: [paiId] }),
  });
  const criada = await criarRes.json();
  if (!criarRes.ok) throw new Error('Falha ao criar pasta: ' + JSON.stringify(criada));
  return criada.id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }
  try {
    const accessToken = await getAccessToken();
    const { action } = req.body || {};

    if (action === 'ensureFolders') {
      const { codigoRef, cliente } = req.body;
      const raizId = await acharOuCriarPasta(accessToken, 'G4 Investimóveis - Contratos', 'root');
      const nomeContrato = `${codigoRef ? 'Ref. ' + codigoRef + ' - ' : ''}${cliente || 'Sem nome'}`;
      const pastaContratoId = await acharOuCriarPasta(accessToken, nomeContrato, raizId);
      const [documentos, fotos, contrato] = await Promise.all([
        acharOuCriarPasta(accessToken, 'Documentos', pastaContratoId),
        acharOuCriarPasta(accessToken, 'Fotos', pastaContratoId),
        acharOuCriarPasta(accessToken, 'Contrato', pastaContratoId),
      ]);
      res.status(200).json({ pastaContratoId, documentos, fotos, contrato });
      return;
    }

    if (action === 'list') {
      const { folderId } = req.body;
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const dataRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,webViewLink,thumbnailLink,mimeType)&orderBy=createdTime desc`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await dataRes.json();
      if (!dataRes.ok) throw new Error(JSON.stringify(data));
      res.status(200).json({ files: data.files || [] });
      return;
    }

    if (action === 'upload') {
      const { folderId, fileName, mimeType, dataBase64 } = req.body;
      const buffer = Buffer.from(dataBase64, 'base64');
      const metadata = { name: fileName, parents: [folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
      const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,thumbnailLink', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      const uploaded = await upRes.json();
      if (!upRes.ok) throw new Error(JSON.stringify(uploaded));
      res.status(200).json(uploaded);
      return;
    }

    if (action === 'delete') {
      const { fileId } = req.body;
      const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!delRes.ok) throw new Error(await delRes.text());
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
