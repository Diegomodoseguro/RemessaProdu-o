const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const { createClient } = require('@supabase/supabase-js');
let Resend;
let resendClient = null;
try {
    Resend = require('resend').Resend;
} catch (e) {}

let supabase;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nklclnadvlqvultatapb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rbGNsbmFkdmxxdnVsdGF0YXBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1OTQ1OTUsImV4cCI6MjA3OTE3MDU5NX0.aRINn2McObJn9N4b3fEG262mR92e_MiP60jX13mtxKw';
const RESEND_API_KEY = process.env.RESEND_API_KEY; 

try {
    if (SUPABASE_URL && SUPABASE_KEY) supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    if (Resend && RESEND_API_KEY) resendClient = new Resend(RESEND_API_KEY);
} catch (e) {}

const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@' 
};

let MODOSEGU_BASE = process.env.MODOSEGU_URL || 'https://portalv2.modoseguro.digital/api';
if (MODOSEGU_BASE.endsWith('/')) MODOSEGU_BASE = MODOSEGU_BASE.slice(0, -1);
const MODOSEGU_ENDPOINT = MODOSEGU_BASE.includes('/stripe/dispatch') ? MODOSEGU_BASE : `${MODOSEGU_BASE}/stripe/dispatch`;

function decodeHtmlEntities(str) {
    if (!str) return "";
    return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        const body = JSON.parse(event.body);
        const { action } = body;

        if (action === 'processPayment') {
            return await handlePaymentAndEmission(body);
        } else if (action === 'getPlans') {
            return await handleGetPlans(body);
        }
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
    } catch (error) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};

async function handleGetPlans(data) {
    // ... (mesma lógica de antes, omitida para brevidade)
    // Se precisar testar cotação, use o código anterior.
    // Focando no erro de emissão aqui.
    return { statusCode: 200, body: JSON.stringify({ success: true, message: "Use o endpoint de pagamento para teste." }) };
}

async function handlePaymentAndEmission(data) {
    const { paymentMethodId } = data;
    
    // BYPASS PAGAMENTO (Para focar na Coris)
    // Se for tok_visa, assumimos sucesso no pagamento
    if (paymentMethodId !== 'tok_visa') {
         // Lógica real de pagamento omitida para este teste
    }

    // TENTATIVA DE EMISSÃO COM DEBUG
    try {
        const emissionResult = await emitirCorisReal(data);
        return { 
            statusCode: 200, 
            headers: HEADERS, 
            body: JSON.stringify({ 
                success: true, 
                voucher: emissionResult.voucher,
                xml_debug: emissionResult.xml // Retorna o XML para você ver no Postman
            }) 
        };
    } catch (e) {
        return { 
            statusCode: 200, // Retorna 200 para você ver o JSON
            headers: HEADERS, 
            body: JSON.stringify({ 
                success: false, 
                voucher: "ERRO", 
                error_message: e.message,
                xml_debug: e.xml || "Sem XML" // Mostra o XML de erro se houver
            }) 
        };
    }
}

async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/'); 
    const dtInicio = formatDate(dates.start);
    const dtFim = formatDate(dates.end);
    const cleanStr = (s) => s ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() : "";
    const cleanNum = (n) => n ? n.replace(/\D/g, '') : "";

    // XML SOAP (Mesmo do anterior)
    let innerContent = '';
    if (passengers.length === 1) {
        const p = passengers[0];
        innerContent = `<execute><param name='login' type='varchar' value='${CORIS_CONFIG.login}'/><param name='senha' type='varchar' value='${CORIS_CONFIG.senha}'/><param name='idplano' type='int' value='${planId}' /><param name='qtdpaxes' type='int' value='1' /><param name='familiar' type='char' value='N' /><param name='inicioviagem' type='varchar' value='${dtInicio}' /><param name='fimviagem' type='varchar' value='${dtFim}' /><param name='destino' type='int' value='${data.destination || 4}' /><param name='nome' type='varchar' value='${cleanStr(p.nome.split(' ')[0])}' /><param name='sobrenome' type='varchar' value='${cleanStr(p.nome.split(' ').slice(1).join(' '))}' /><param name='sexo' type='char' value='${p.sexo}' /><param name='dtnascimento' type='varchar' value='${formatDate(p.nascimento)}' /><param name='documento' type='varchar' value='${cleanNum(p.cpf)}' /><param name='tipodoc' type='varchar' value='CPF' /><param name='file' type='varchar' value='' /><param name='endereco' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='telefone' type='varchar' value='${cleanNum(contactPhone)}' /><param name='cidade' type='varchar' value='${cleanStr(comprador.endereco.cidade)}' /><param name='uf' type='char' value='${comprador.endereco.uf}' /><param name='cep' type='varchar' value='${cleanNum(comprador.endereco.cep)}' /><param name='contatonome' type='varchar' value='${cleanStr(comprador.nome)}' /><param name='contatofone' type='varchar' value='${cleanNum(contactPhone)}' /><param name='contatoendereco' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='formapagamento' type='varchar' value='FA' /><param name='processo' type='int' value='0' /><param name='meio' type='int' value='0' /><param name='email' type='varchar' value='${comprador.email}' /><param name='angola' type='char' value='N' /><param name='furtoelet' type='int' value='0' /><param name='bagagens' type='int' value='0' /><param name='morteac' type='int' value='0' /><param name='mortenat' type='int' value='0' /><param name='cancplus' type='int' value='0' /><param name='cancany' type='int' value='0' /><param name='codigofree' type='varchar' value='' /><param name='valorvenda' type='float' value='00.00' /><param name='categoria' type='int' value='1' /><param name='danosmala' type='int' value='0' /><param name='dataitemviagem' type='varchar' value='' /><param name='bairro' type='varchar' value='${cleanStr(comprador.endereco.bairro)}' /><param name='numero' type='varchar' value='${comprador.endereco.numero}' /><param name='endcomplemento' type='varchar' value='${cleanStr(comprador.endereco.complemento || '')}' /><param name='vouchercredito' type='varchar' value='0' /><param name='pet' type='int' value='0' /><param name='p1' type='varchar' value='0' /><param name='p2' type='varchar' value='0' /><param name='p3' type='varchar' value='0' /></execute>`;
    } else {
        // ... (multi pax logic)
    }

    const soapEnvelope = `<soapenv:Envelope xmlns:soapenv='http://schemas.xmlsoap.org/soap/envelope/' xmlns:tem='http://tempuri.org/'><soapenv:Header/><soapenv:Body><tem:InsereVoucherIndividualV13><tem:strXML><![CDATA[${innerContent}]]></tem:strXML></tem:InsereVoucherIndividualV13></soapenv:Body></soapenv:Envelope>`;

    const response = await fetch(CORIS_CONFIG.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/InsereVoucherIndividualV13` }, body: soapEnvelope });
    const rawText = await response.text();
    const cleanResponse = decodeHtmlEntities(rawText);
    const match = cleanResponse.match(/<voucher>(.*?)<\/voucher>/i);
    
    if (match && match[1] && match[1].trim() !== '') {
        return { voucher: match[1], xml: cleanResponse };
    }

    // Se falhar, lança erro com o XML para debug
    const err = new Error("Falha Coris");
    err.xml = cleanResponse; // Anexa o XML ao objeto de erro
    throw err;
}
