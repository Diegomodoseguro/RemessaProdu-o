const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const { createClient } = require('@supabase/supabase-js');
let supabase;

// CONFIGURAÇÃO SUPABASE (GARANTIDA)
// Usa variáveis de ambiente se existirem, senão usa as chaves diretas (igual ao seu adm.html)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nklclnadvlqvultatapb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rbGNsbmFkdmxxdnVsdGF0YXBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1OTQ1OTUsImV4cCI6MjA3OTE3MDU5NX0.aRINn2McObJn9N4b3fEG262mR92e_MiP60jX13mtxKw';

try {
    if (SUPABASE_URL && SUPABASE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
} catch (e) { console.error("Erro Supabase Init:", e); }

const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@' 
};

const MODOSEGU_URL = process.env.MODOSEGU_URL || 'http://localhost:5020/api/stripe/dispatch';

function decodeHtmlEntities(str) {
    if (!str) return "";
    return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        if (!event.body) throw new Error("Dados não recebidos.");
        const body = JSON.parse(event.body);
        const { action } = body;

        console.log(`Ação recebida: ${action}`);

        switch (action) {
            case 'getPlans': return await handleGetPlans(body);
            case 'processPayment': return await handlePaymentAndEmission(body);
            default: return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("Erro Backend:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message || "Erro interno." }) };
    }
};

// --- PARSER XML ---
function parsePlansFromXML(xmlRaw) {
    const plans = [];
    const cleanXML = decodeHtmlEntities(xmlRaw);
    
    // Captura as linhas da tabela
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
            let priceClean = precoStr.replace(/\./g, '').replace(',', '.');
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

                plans.push({ id, nome, basePrice, dmh, bagagem: 'USD 1.500', covid: 'USD 10.000' });
            }
        }
    }
    return plans;
}

// --- 1. BUSCA DE PLANOS (VALIDADO + COMISSÃO GARANTIDA) ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        // --- Lógica de Comissão Conectada ao Banco ---
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) {
                commissionRate = parseFloat(data.value);
                console.log(`[Pricing] Aplicando Comissão do Admin: ${commissionRate}%`);
            } else {
                console.log(`[Pricing] Nenhuma comissão configurada ou encontrada. Usando 0%.`);
            }
        } else {
            console.warn("[Pricing] Supabase não inicializado. Comissão será 0%.");
        }

        // XML Validado (Padrão Postman)
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

        console.log(`Buscando planos Coris... Destino: ${destino}`);
        
        const response = await fetch(CORIS_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: soapBody
        });

        const xmlResponse = await response.text();
        
        if (!response.ok) {
            throw new Error(`Erro HTTP ${response.status} da Seguradora.`);
        }

        let allPlans = parsePlansFromXML(xmlResponse);

        if (allPlans.length === 0) {
            console.error("XML Coris vazio/erro. Resposta bruta:", xmlResponse.substring(0, 500));
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

        // Aplica a comissão buscada no banco
        const finalPlans = filteredPlans.map(p => ({
            ...p,
            totalPrice: calculateFinalPrice(p.basePrice, idades, commissionRate),
            covid: 'USD 10.000'
        }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: finalPlans }) };

    } catch (e) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Falha Cotação: ${e.message}` }) };
    }
}

// Cálculo do Preço Final (Base + Margem + Agravo Idade)
function calculateFinalPrice(basePrice, ages, commissionRate = 0) {
    let total = 0;
    // Preço Base + % de Comissão do Admin
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

    const modoSeguPayload = {
        "tenant_id": "RODQ19", "tipo": "stripe",
        "cliente": { "nome": comprador.nome, "email": comprador.email, "telefone": contactPhone || "0000000000", "cpf_cnpj": comprador.cpf },
        "enderecos": [{ "tipo": "residencial", "cep": comprador.endereco.cep, "logradouro": comprador.endereco.logradouro, "numero": comprador.endereco.numero, "complemento": comprador.endereco.complemento || "", "bairro": comprador.endereco.bairro, "cidade": comprador.endereco.cidade, "uf": comprador.endereco.uf }],
        "pagamento": {
            "amount_cents": Math.round(amountBRL * 100), "currency": "brl", "descricao": `Seguro - ${planName}`, "receipt_email": comprador.email,
            "metadata": { "pedido_id": leadId, "origem": "site_remessa" }, "payment_method_id": paymentMethodId
        }
    };

    let paymentStatus = 'failed', errorMessage = '';
    try {
        const response = await fetch(MODOSEGU_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modoSeguPayload) });
        if (response.ok) paymentStatus = 'succeeded';
        else { const errJson = await response.json(); errorMessage = errJson.error?.message || errJson.error || "Pagamento recusado."; }
    } catch (err) { return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Erro comunicação Pagamento." }) }; }

    if (paymentStatus !== 'succeeded') return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: errorMessage }) };

    let voucherCode = 'PENDENTE', emissionStatus = 'emitido', emissionError = null;
    try {
        voucherCode = await emitirCorisReal(data);
    } catch (e) {
        console.error("Erro Emissão:", e.message);
        emissionStatus = 'erro_emissao'; emissionError = e.message;
    }

    if (supabase) {
        await supabase.from('remessaonlinesioux_leads').update({ status: emissionStatus, valor_total: amountBRL, plano_nome: planName, coris_voucher: voucherCode, coris_response_xml: emissionError || 'Sucesso' }).eq('id', leadId);
    }

    let msg = "Pagamento Aprovado! Apólice emitida.";
    if (emissionStatus === 'erro_emissao') msg = "Pagamento Aprovado! Voucher será enviado manualmente em breve.";

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, voucher: voucherCode, message: msg }) };
}

// --- EMISSÃO CORRIGIDA (PADRÃO POSTMAN COM TIPOS) ---
async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/'); // YYYY/MM/DD
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
    if (match && match[1] && match[1].trim() !== '') return match[1];

    const errMatch = cleanResponse.match(/<erro>(.*?)<\/erro>/i);
    const errCode = errMatch ? errMatch[1] : 'Desconhecido';
    if (errCode && errCode !== '0') throw new Error(`Coris recusou: Erro ${errCode}`);
    throw new Error("Falha na emissão: Resposta sem voucher.");
}
