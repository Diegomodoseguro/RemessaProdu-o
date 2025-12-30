const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const { createClient } = require('@supabase/supabase-js');

// Importação Segura do Resend
let Resend;
let resendClient = null;

try {
    const resendModule = require('resend');
    Resend = resendModule.Resend;
} catch (e) {
    console.warn("[Backend Init] Módulo 'resend' não encontrado. Emails desativados.");
}

let supabase;

// 1. CONFIGURAÇÕES
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nklclnadvlqvultatapb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rbGNsbmFkdmxxdnVsdGF0YXBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1OTQ1OTUsImV4cCI6MjA3OTE3MDU5NX0.aRINn2McObJn9N4b3fEG262mR92e_MiP60jX13mtxKw';
const RESEND_API_KEY = process.env.RESEND_API_KEY; 

// URLs
const LINK_CONDICOES_GERAIS = 'https://seguroremessa.online/condicoesgerais_coris2025.pdf';
const LINK_ABRIR_SINISTRO = 'https://www.coris.com.br/sinistros';
const TELEFONE_SUPORTE = '+55 11 90742-5892';
const WHATSAPP_LINK = 'https://wa.me/5511907425892';

// Inicialização
try {
    if (SUPABASE_URL && SUPABASE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    
    if (Resend && RESEND_API_KEY) {
        resendClient = new Resend(RESEND_API_KEY);
        console.log("[Backend Init] Resend inicializado com sucesso.");
    } else {
        console.log("[Backend Init] Resend não configurado (Falta chave ou módulo).");
    }
} catch (e) { console.error("[Backend Init] Erro fatal na inicialização:", e); }

const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@' 
};

// URL DO MODOSEGU CORRIGIDA PARA PRODUÇÃO
const MODOSEGU_URL = process.env.MODOSEGU_URL || 'https://portalv2.modoseguro.digital/api';

function decodeHtmlEntities(str) {
    if (!str) return "";
    return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

exports.handler = async (event, context) => {
    // Tratamento de Preflight (OPTIONS)
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        if (!event.body) throw new Error("Dados não recebidos.");
        
        let body;
        try {
            body = JSON.parse(event.body);
        } catch (e) {
            throw new Error("JSON inválido no corpo da requisição.");
        }

        const { action } = body;
        console.log(`[Action] Recebida: ${action}`);

        switch (action) {
            case 'getPlans': return await handleGetPlans(body);
            case 'processPayment': return await handlePaymentAndEmission(body);
            default: return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("[Erro Handler]", error);
        return { 
            statusCode: 500, 
            headers: HEADERS, 
            body: JSON.stringify({ error: error.message || "Erro interno no servidor." }) 
        };
    }
};

// ... [O RESTANTE DO CÓDIGO PERMANECE O MESMO] ...

// --- ENRIQUECIMENTO DE DADOS ---
function enrichPlanData(plan) {
    const nome = (plan.nome || "").toUpperCase();
    let details = {
        bagagem: 'USD 1.000',
        farmacia: 'USD 500',
        odonto: 'USD 500',
        traslado_corpo: 'USD 20.000',
        regresso: 'USD 20.000',
        cancelamento: 'USD 1.000',
        morte: 'R$ 30.000'
    };

    if (nome.includes('30')) {
        details = { bagagem: 'USD 1.200', farmacia: 'USD 600', odonto: 'USD 600', traslado_corpo: 'USD 30.000', regresso: 'USD 30.000', cancelamento: 'USD 1.000', morte: 'R$ 30.000' };
    } else if (nome.includes('60')) {
        details = { bagagem: 'USD 1.500', farmacia: 'USD 1.000', odonto: 'USD 800', traslado_corpo: 'USD 50.000', regresso: 'USD 50.000', cancelamento: 'USD 1.500', morte: 'R$ 50.000' };
    } else if (nome.includes('100')) {
        details = { bagagem: 'USD 2.000', farmacia: 'USD 1.000', odonto: 'USD 1.000', traslado_corpo: 'USD 50.000', regresso: 'USD 50.000', cancelamento: 'USD 2.000', morte: 'R$ 50.000' };
    } else if (nome.includes('250') || nome.includes('500') || nome.includes('1MM') || nome.includes('1KK')) {
        details = { bagagem: 'USD 3.000', farmacia: 'USD 2.000', odonto: 'USD 2.000', traslado_corpo: 'USD 100.000', regresso: 'USD 100.000', cancelamento: 'USD 3.000', morte: 'R$ 100.000' };
    }

    return { ...plan, ...details, covid: 'USD 10.000' };
}

// --- PARSER XML ---
function parsePlansFromXML(xmlRaw) {
    const plans = [];
    const cleanXML = decodeHtmlEntities(xmlRaw);
    const rows = cleanXML.match(/<row>([\s\S]*?)<\/row>/gi);

    if (!rows || rows.length === 0) return [];

    for (const row of rows) {
        const getCol = (name) => {
            const regex = new RegExp(`<column name="${name}">(.*?)<\/column>`, 'i');
            const match = row.match(regex);
            return match ? match[1] : null;
        };

        const id = getCol('id');
        const nome = getCol('nome');
        const precoStr = getCol('preco'); 

        if (id && nome && precoStr) {
            let priceClean = precoStr.trim().replace(/\./g, '').replace(',', '.');
            const basePrice = parseFloat(priceClean);
            
            if (!isNaN(basePrice) && basePrice > 0) {
                let dmh = 'USD 30.000';
                const n = nome.toUpperCase();
                if (n.includes('60')) dmh = 'USD 60.000';
                if (n.includes('100')) dmh = 'USD 100.000';
                if (n.includes('150')) dmh = 'USD 150.000';
                if (n.includes('250')) dmh = 'USD 250.000';
                if (n.includes('500')) dmh = 'USD 500.000';
                if (n.includes('1KK') || n.includes('1MM')) dmh = 'USD 1.000.000';

                const rawPlan = { id, nome, basePrice, dmh };
                plans.push(enrichPlanData(rawPlan));
            }
        }
    }
    return plans;
}

// --- 1. BUSCA DE PLANOS ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) {
                let valStr = String(data.value).trim().replace(',', '.').replace('%', '');
                commissionRate = parseFloat(valStr);
                if (isNaN(commissionRate)) commissionRate = 0;
            }
        }

        const innerXML = `
<execute>
<param name='login' type='varchar' value='${CORIS_CONFIG.login}' />
<param name='senha' type='varchar' value='${CORIS_CONFIG.senha}' />
<param name='destino' type='int' value='${destino}' />
<param name='vigencia' type='int' value='${dias}' />
<param name='home' type='int' value='0' />
<param name='multi' type='int' value='0' />
</execute>`;

        const soapBody = `<soapenv:Envelope xmlns:soapenv='http://schemas.xmlsoap.org/soap/envelope/' xmlns:tem='http://tempuri.org/'>
<soapenv:Header/>
<soapenv:Body>
<tem:BuscarPlanosNovosV13>
<tem:strXML>
<![CDATA[${innerXML}]]>
</tem:strXML>
</tem:BuscarPlanosNovosV13>
</soapenv:Body>
</soapenv:Envelope>`;

        const response = await fetch(CORIS_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: soapBody
        });

        const xmlResponse = await response.text();
        if (!response.ok) throw new Error(`Erro HTTP ${response.status} da Seguradora.`);

        let allPlans = parsePlansFromXML(xmlResponse);

        if (allPlans.length === 0) {
            if (xmlResponse.includes("NOK") || xmlResponse.includes("Erro")) {
                 const errMsg = decodeHtmlEntities(xmlResponse).match(/<detail>(.*?)<\/detail>/)?.[1] || "Erro desconhecido";
                 throw new Error("Erro na Seguradora: " + errMsg);
            }
            throw new Error("Nenhum plano disponível para esta data/destino.");
        }

        let filteredPlans = [];
        const isVip = (planType === 'vip');

        if (isVip) {
            filteredPlans = allPlans.filter(p => {
                const n = p.nome.toUpperCase();
                return (n.includes('60') || n.includes('100') || n.includes('150') || n.includes('250') || n.includes('500') || n.includes('1KK'));
            });
            filteredPlans.sort((a,b) => b.basePrice - a.basePrice);
        } else {
            filteredPlans = allPlans.filter(p => {
                const n = p.nome.toUpperCase();
                return (n.includes('30') || n.includes('60') || n.includes('100')) && !n.includes('1KK');
            });
            filteredPlans.sort((a,b) => a.basePrice - b.basePrice);
        }

        if (filteredPlans.length === 0) filteredPlans = allPlans;
        filteredPlans = filteredPlans.slice(0, 6);

        const finalPlans = filteredPlans.map(p => {
            const final = calculateFinalPrice(p.basePrice, idades, commissionRate);
            return { ...p, totalPrice: final };
        });

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: finalPlans }) };

    } catch (e) {
        console.error("[GetPlans Error]", e);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Falha Cotação: ${e.message}` }) };
    }
}

function calculateFinalPrice(basePrice, ages, commissionRate = 0) {
    let total = 0;
    const priceWithCommission = basePrice * (1 + (commissionRate / 100));
    ages.forEach(age => {
        const id = parseInt(age);
        let m = 1.0; 
        if (id >= 66 && id <= 70) m = 1.25; 
        else if (id >= 71 && id <= 80) m = 2.00; 
        else if (id >= 81 && id <= 85) m = 3.00; 
        total += (priceWithCommission * m);
    });
    return total;
}

// --- 2. PAGAMENTO E EMISSÃO ---
async function handlePaymentAndEmission(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName, contactPhone, tripReason } = data;

    // Payload conforme documentação ModoSegu
    const modoSeguPayload = {
        "tenant_id": "RODQ19", // Confirme se este ID está correto
        "tipo": "stripe",
        "cliente": { 
            "nome": comprador.nome, 
            "email": comprador.email, 
            "telefone": contactPhone || "0000000000", 
            "cpf_cnpj": comprador.cpf 
        },
        "enderecos": [{ 
            "tipo": "residencial", 
            "cep": comprador.endereco.cep, 
            "logradouro": comprador.endereco.logradouro, 
            "numero": comprador.endereco.numero, 
            "complemento": comprador.endereco.complemento || "", 
            "bairro": comprador.endereco.bairro, 
            "cidade": comprador.endereco.cidade, 
            "uf": comprador.endereco.uf 
        }],
        "pagamento": {
            "amount_cents": Math.round(amountBRL * 100), // Em centavos
            "currency": "brl",
            "descricao": `Seguro Viagem - ${planName} (Lead ${leadId})`,
            "receipt_email": comprador.email,
            "metadata": { 
                "pedido_id": leadId, 
                "origem": "site_remessa", 
                "motivo_viagem": tripReason 
            },
            "payment_method_id": paymentMethodId
        }
    };

    let paymentStatus = 'failed', errorMessage = '';
    try {
        const response = await fetch(MODOSEGU_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modoSeguPayload) });
        if (response.ok) {
            paymentStatus = 'succeeded';
        } else { 
            const errJson = await response.json(); 
            errorMessage = errJson.error?.message || errJson.error || "Pagamento recusado."; 
        }
    } catch (err) { 
        console.error("Erro Conexão Dispatcher:", err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Erro comunicação Pagamento." }) }; 
    }

    if (paymentStatus !== 'succeeded') return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: errorMessage }) };

    let voucherCode = 'PENDENTE', emissionStatus = 'emitido', emissionError = null;
    let emissionXml = '';

    try {
        // Tenta emitir
        const emissionResult = await emitirCorisReal(data);
        voucherCode = emissionResult.voucher;
        emissionXml = emissionResult.xml;
        
        // Tenta enviar e-mail se Resend estiver OK
        if (voucherCode && voucherCode !== 'PENDENTE' && resendClient) {
            try {
                await sendVoucherEmail({
                    to: comprador.email,
                    name: comprador.nome,
                    planName: planName,
                    voucher: voucherCode,
                    dates: data.dates,
                    passengers: data.passengers,
                    price: amountBRL
                });
            } catch (emailErr) {
                console.error("[Email] Falha no envio (não impede venda):", emailErr);
            }
        }

    } catch (e) {
        console.error("Erro Emissão:", e.message);
        emissionStatus = 'erro_emissao'; 
        emissionError = e.message;
        emissionXml = e.message;
    }

    if (supabase) {
        await supabase.from('remessaonlinesioux_leads').update({
            status: emissionStatus,
            valor_total: amountBRL,
            plano_nome: planName,
            coris_voucher: voucherCode,
            coris_response_xml: emissionXml || emissionError || 'Sucesso' 
        }).eq('id', leadId);
    }

    let msg = "Pagamento Aprovado! Apólice emitida.";
    if (emissionStatus === 'erro_emissao') msg = "Pagamento Aprovado! Voucher será enviado manualmente em breve.";

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, voucher: voucherCode, message: msg }) };
}

// --- FUNÇÃO DE ENVIO DE E-MAIL ---
async function sendVoucherEmail({ to, name, planName, voucher, dates, passengers, price }) {
    if (!resendClient) return;

    const planDetails = enrichPlanData({ nome: planName });
    const formatDate = (d) => d.split('-').reverse().join('/');
    const start = formatDate(dates.start);
    const end = formatDate(dates.end);

    const paxListHtml = passengers.map(p => 
        `<li style="margin-bottom: 8px; color: #444;">
            <span style="font-weight:600; color:#000;">${p.nome}</span> 
            <span style="color:#777; font-size:12px;">(CPF: ${p.cpf})</span>
        </li>`
    ).join('');

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; color: #333; }
            .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); overflow: hidden; }
            .header { background-color: #2244FF; padding: 30px 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
            .content { padding: 40px 30px; }
            .voucher-box { background-color: #f0fdf4; border: 1px dashed #22c55e; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0; }
            .voucher-code { font-size: 28px; font-weight: 800; color: #166534; letter-spacing: 2px; font-family: 'Courier New', monospace; }
            .section-title { font-size: 16px; font-weight: 700; color: #000733; margin: 30px 0 15px; border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; text-transform: uppercase; }
            .info-grid { width: 100%; border-collapse: collapse; }
            .info-grid td { padding: 12px 0; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
            .btn { display: inline-block; padding: 14px 28px; border-radius: 50px; text-decoration: none; font-weight: 700; font-size: 14px; background-color: #2244FF; color: #ffffff; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header"><h1>Compra Confirmada! ✈️</h1></div>
            <div class="content">
                <p>Olá, <strong>${name.split(' ')[0]}</strong>!</p>
                <div class="voucher-box"><p class="voucher-code">${voucher}</p></div>
                <div class="section-title">📋 Resumo da Viagem</div>
                <table class="info-grid">
                    <tr><td>Plano</td><td>${planName}</td></tr>
                    <tr><td>Vigência</td><td>${start} até ${end}</td></tr>
                    <tr><td>Passageiros</td><td><ul>${paxListHtml}</ul></td></tr>
                </table>
                <div style="text-align:center; margin-top:30px;"><a href="${LINK_ABRIR_SINISTRO}" class="btn">Abrir Chamado</a></div>
            </div>
        </div>
    </body>
    </html>`;

    await resendClient.emails.send({
        from: 'Seguro Remessa Online <noreply@seguroremessa.online>',
        to: [to],
        subject: `Confirmação de Compra - Voucher ${voucher}`,
        html: htmlContent
    });
}

// --- EMISSÃO CORIS ---
async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/'); 
    const dtInicio = formatDate(dates.start);
    const dtFim = formatDate(dates.end);
    const cleanStr = (s) => s ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() : "";
    const cleanNum = (n) => n ? n.replace(/\D/g, '') : "";

    let innerContent = '';
    const soapAction = passengers.length === 1 ? 'InsereVoucherIndividualV13' : 'InsereVoucherFamiliarV13';

    if (passengers.length === 1) {
        const p = passengers[0];
        innerContent = `
<execute>
<param name='login' type='varchar' value='${CORIS_CONFIG.login}'/>
<param name='senha' type='varchar' value='${CORIS_CONFIG.senha}'/>
<param name='idplano' type='int' value='${planId}' />
<param name='qtdpaxes' type='int' value='1' />
<param name='familiar' type='char' value='N' />
<param name='inicioviagem' type='varchar' value='${dtInicio}' />
<param name='fimviagem' type='varchar' value='${dtFim}' />
<param name='destino' type='int' value='${data.destination || 4}' />
<param name='nome' type='varchar' value='${cleanStr(p.nome.split(' ')[0])}' />
<param name='sobrenome' type='varchar' value='${cleanStr(p.nome.split(' ').slice(1).join(' '))}' />
<param name='sexo' type='char' value='${p.sexo}' />
<param name='dtnascimento' type='varchar' value='${formatDate(p.nascimento)}' />
<param name='documento' type='varchar' value='${cleanNum(p.cpf)}' />
<param name='tipodoc' type='varchar' value='CPF' />
<param name='file' type='varchar' value='' />
<param name='endereco' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}' />
<param name='telefone' type='varchar' value='${cleanNum(contactPhone)}' />
<param name='cidade' type='varchar' value='${cleanStr(comprador.endereco.cidade)}' />
<param name='uf' type='char' value='${comprador.endereco.uf}' />
<param name='cep' type='varchar' value='${cleanNum(comprador.endereco.cep)}' />
<param name='contatonome' type='varchar' value='${cleanStr(data.contactName || comprador.nome)}' />
<param name='contatofone' type='varchar' value='${cleanNum(contactPhone)}' />
<param name='contatoendereco' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}' />
<param name='formapagamento' type='varchar' value='FA' />
<param name='processo' type='int' value='0' />
<param name='meio' type='int' value='0' />
<param name='email' type='varchar' value='${comprador.email}' />
<param name='angola' type='char' value='N' />
<param name='furtoelet' type='int' value='0' />
<param name='bagagens' type='int' value='0' />
<param name='morteac' type='int' value='0' />
<param name='mortenat' type='int' value='0' />
<param name='cancplus' type='int' value='0' />
<param name='cancany' type='int' value='0' />
<param name='codigofree' type='varchar' value='' />
<param name='valorvenda' type='float' value='00.00' />
<param name='categoria' type='int' value='1' />
<param name='danosmala' type='int' value='0' />
<param name='dataitemviagem' type='varchar' value='' />
<param name='bairro' type='varchar' value='${cleanStr(comprador.endereco.bairro)}' />
<param name='numero' type='varchar' value='${comprador.endereco.numero}' />
<param name='endcomplemento' type='varchar' value='${cleanStr(comprador.endereco.complemento || '')}' />
<param name='vouchercredito' type='varchar' value='0' />
<param name='pet' type='int' value='0' />
<param name='p1' type='varchar' value='0' />
<param name='p2' type='varchar' value='0' />
<param name='p3' type='varchar' value='0' />
</execute>`;
    } else {
        let paxParams = '';
        passengers.forEach((p, idx) => {
            const i = idx + 1;
            paxParams += `
<param name='nome${i}' type='varchar' value='${cleanStr(p.nome.split(' ')[0])}' />
<param name='sobrenome${i}' type='varchar' value='${cleanStr(p.nome.split(' ').slice(1).join(' '))}' />
<param name='sexo${i}' type='char' value='${p.sexo}' />
<param name='dtnascimento${i}' type='varchar' value='${formatDate(p.nascimento)}' />
<param name='documento${i}' type='varchar' value='${cleanNum(p.cpf)}' />
<param name='tipodoc${i}' type='varchar' value='CPF' />
<param name='file${i}' type='varchar' value='' />
<param name='endereco${i}' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}' />
<param name='telefone${i}' type='varchar' value='${cleanNum(contactPhone)}' />
<param name='cidade${i}' type='varchar' value='${cleanStr(comprador.endereco.cidade)}' />
<param name='uf${i}' type='char' value='${comprador.endereco.uf}' />
<param name='cep${i}' type='varchar' value='${cleanNum(comprador.endereco.cep)}' />
<param name='bairro${i}' type='varchar' value='${cleanStr(comprador.endereco.bairro)}' />
<param name='numero${i}' type='varchar' value='${comprador.endereco.numero}' />
<param name='endcomplemento${i}' type='varchar' value='${cleanStr(comprador.endereco.complemento || '')}' />
<param name='voucherCreditoPax${i}' type='varchar' value='' />`;
        });
        
        for(let k = passengers.length + 1; k <= 6; k++) {
             paxParams += `<param name='nome${k}' type='varchar' value='' /><param name='sobrenome${k}' type='varchar' value='' /><param name='sexo${k}' type='char' value='' /><param name='dtnascimento${k}' type='varchar' value='' /><param name='documento${k}' type='varchar' value='' /><param name='tipodoc${k}' type='varchar' value='' /><param name='file${k}' type='varchar' value='' /><param name='endereco${k}' type='varchar' value='' /><param name='telefone${k}' type='varchar' value='' /><param name='cidade${k}' type='varchar' value='' /><param name='uf${k}' type='char' value='' /><param name='cep${k}' type='varchar' value='' /><param name='bairro${k}' type='varchar' value='' /><param name='numero${k}' type='varchar' value='' /><param name='endcomplemento${k}' type='varchar' value='' /><param name='voucherCreditoPax${k}' type='varchar' value='' />`;
        }

        innerContent = `
<execute> 
<param name='login' type='varchar' value='${CORIS_CONFIG.login}' />  
<param name='senha' type='varchar' value='${CORIS_CONFIG.senha}' />  
<param name='idplano' type='int' value='${planId}' /> 
<param name='qtdpaxes' type='int' value='${passengers.length}' /> 
<param name='inicioviagem' type='varchar' value='${dtInicio}' /> 
<param name='fimviagem' type='varchar' value='${dtFim}' /> 
<param name='destino' type='int' value='${data.destination || 4}' /> 
${paxParams}
<param name='contatonome' type='varchar' value='${cleanStr(data.contactName || comprador.nome)}' /> 
<param name='contatofone' type='varchar' value='${cleanNum(contactPhone)}' /> 
<param name='contatoendereco' type='varchar' value='${cleanStr(comprador.endereco.logradouro)}'/>
<param name='formapagamento' type='varchar' value='FA'/>
<param name='processo' type='int' value='0'/>
<param name='meio' type='int' value='0'/>
<param name='email' type='varchar' value='${comprador.email}'/>
<param name='angola' type='char' value='N'/>
<param name='morteac' type='int' value='0'/>
<param name='mortenat' type='int' value='0'/>
<param name='esportes' type='int' value='0'/>
<param name='bagagens' type='int' value='0'/>
<param name='cancplus' type='int' value='0'/>
<param name='cancany' type='int' value='0'/>
<param name='furtoelet' type='int' value='0' />
<param name='categoria' type='int' value='1'/>
<param name='valorvenda' type='float' value='00.00' /> 
<param name='codigofree' type='varchar' value=''/>
<param name='danosmala' type='int' value='0'/>
<param name='pet' type='int' value='0' />
<param name='dataitemviagem' type='varchar' value=''/>
<param name='p1' type='varchar' value=''/>
<param name='p2' type='varchar' value=''/>
<param name='p3' type='varchar' value=''/>
</execute>`;
    }

    const soapEnvelope = `<soapenv:Envelope xmlns:soapenv='http://schemas.xmlsoap.org/soap/envelope/' xmlns:tem='http://tempuri.org/'>
<soapenv:Header/>
<soapenv:Body>
<tem:${soapAction}>
<tem:strXML>
<![CDATA[${innerContent}]]>
</tem:strXML>
</tem:${soapAction}>
</soapenv:Body>
</soapenv:Envelope>`;

    const response = await fetch(CORIS_CONFIG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/${soapAction}` },
        body: soapEnvelope
    });

    const rawText = await response.text();
    const cleanResponse = decodeHtmlEntities(rawText);
    const match = cleanResponse.match(/<voucher>(.*?)<\/voucher>/i);
    const voucher = match && match[1] && match[1].trim() !== '' ? match[1] : null;

    if (!voucher) {
        const errMatch = cleanResponse.match(/<erro>(.*?)<\/erro>/i);
        const errCode = errMatch ? errMatch[1] : 'Desconhecido';
        if (errCode && errCode !== '0') throw new Error(`Coris recusou: Erro ${errCode}`);
        throw new Error("Falha na emissão: Resposta sem voucher.");
    }
    
    return { voucher, xml: cleanResponse };
}
