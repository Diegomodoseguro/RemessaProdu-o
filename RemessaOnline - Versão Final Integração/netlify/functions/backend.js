const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const { createClient } = require('@supabase/supabase-js');
let supabase;

// Inicialização segura do Supabase
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    } else {
        console.warn("Aviso: Variáveis SUPABASE não configuradas.");
    }
} catch (e) { console.error("Erro Supabase Init:", e); }

// CREDENCIAIS DE PRODUÇÃO CORIS
const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@' // Certifique-se que esta senha está válida em produção
};

const MODOSEGU_URL = process.env.MODOSEGU_URL || 'http://localhost:5020/api/stripe/dispatch';

// Função auxiliar para decodificar HTML Entities (Vital para ler o XML da Coris)
function decodeHtmlEntities(str) {
    if (!str) return "";
    return str.replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'");
}

exports.handler = async (event, context) => {
    // Tratamento de CORS para preflight
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        if (!event.body) throw new Error("Dados não recebidos.");
        const body = JSON.parse(event.body);
        const { action } = body;

        console.log(`Recebendo ação: ${action}`); 

        switch (action) {
            case 'getPlans':
                return await handleGetPlans(body);
            case 'processPayment':
                return await handlePaymentAndEmission(body);
            default:
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("Erro Crítico Backend:", error);
        return { 
            statusCode: 500, 
            headers: HEADERS, 
            body: JSON.stringify({ error: error.message || "Erro interno no servidor." }) 
        };
    }
};

// --- PARSER XML (Lê datasets .NET retornados pela Coris) ---
function parsePlansFromXML(xmlRaw) {
    const plans = [];
    
    // 1. Decodifica o XML que vem "escapado" dentro da tag <strXML> ou <return>
    const cleanXML = decodeHtmlEntities(xmlRaw);
    
    // 2. Procura blocos <Table> (Padrão .NET DataSet)
    // Usamos regex global para capturar todas as ocorrências
    const tables = cleanXML.match(/<Table>([\s\S]*?)<\/Table>/gi);

    if (!tables || tables.length === 0) return [];

    for (const block of tables) {
        const extract = (tag) => {
            const match = block.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`, 'i'));
            return match ? match[1] : null;
        };

        const id = extract('id');
        const nome = extract('nome');
        const precoStr = extract('preco'); // Geralmente vem "150,00" (BR) ou "150.00" (US)

        if (id && nome && precoStr) {
            // Normaliza preço: remove pontos de milhar, troca vírgula por ponto
            let priceClean = precoStr.replace(/\./g, '').replace(',', '.');
            const basePrice = parseFloat(priceClean);
            
            if (!isNaN(basePrice) && basePrice > 0) {
                // Inferência de Cobertura pelo Nome (Padrão de Mercado)
                let dmh = 'USD 30.000';
                const n = nome.toUpperCase();
                
                if (n.includes('60')) dmh = 'USD 60.000';
                if (n.includes('100')) dmh = 'USD 100.000';
                if (n.includes('150')) dmh = 'USD 150.000';
                if (n.includes('250')) dmh = 'USD 250.000';
                if (n.includes('500')) dmh = 'USD 500.000';
                if (n.includes('1MM') || n.includes('BLACK')) dmh = 'USD 1.000.000';

                plans.push({
                    id: id,
                    nome: nome,
                    basePrice: basePrice,
                    dmh: dmh,
                    bagagem: 'USD 1.500', 
                    covid: 'USD 10.000'
                });
            }
        }
    }
    return plans;
}

// --- 1. BUSCA DE PLANOS (GET REAL - FORMATO POSTMAN) ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        // 1. Buscar Comissão
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) commissionRate = parseFloat(data.value);
        }

        // 2. Montar Request SOAP (Linha Única Rígida dentro do CDATA para evitar erro de parser)
        // IMPORTANTE: Não quebrar linha dentro do <execute>...</execute>
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <BuscarPlanosNovosV13 xmlns="http://tempuri.org/">
      <strXML><![CDATA[<execute><param name='login' value='${CORIS_CONFIG.login}' /><param name='senha' value='${CORIS_CONFIG.senha}' /><param name='destino' value='${destino}' /><param name='vigencia' value='${dias}' /><param name='home' value='0' /><param name='multi' value='0' /></execute>]]></strXML>
    </BuscarPlanosNovosV13>
  </soap:Body>
</soap:Envelope>`;

        console.log(`[API] Buscando planos na Coris... Destino: ${destino}, Dias: ${dias}`);
        
        const response = await fetch(CORIS_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: xmlBody
        });

        if (!response.ok) {
            throw new Error(`Erro HTTP Coris: ${response.status} ${response.statusText}`);
        }

        const xmlResponse = await response.text();
        
        // 3. Parsear Resposta
        let allPlans = parsePlansFromXML(xmlResponse);

        // --- VALIDAÇÃO CRÍTICA: SEM FALLBACK ---
        if (allPlans.length === 0) {
            console.error("[ERRO CRÍTICO] XML da Coris retornou vazio ou inválido.");
            console.error("XML Recebido (Inicio):", xmlResponse.substring(0, 300));
            
            if (xmlResponse.includes("Login ou senha invalida") || xmlResponse.includes("Erro")) {
                throw new Error("Erro de Autenticação na Seguradora. Verifique as credenciais.");
            }
            
            throw new Error("Nenhum plano disponível para esta data/destino pela Seguradora no momento.");
        }

        // 4. Filtros de Exibição
        let filteredPlans = [];
        const isVip = (planType === 'vip');

        if (isVip) {
            filteredPlans = allPlans.filter(p => {
                const n = p.nome.toUpperCase();
                return (n.includes('60') || n.includes('100') || n.includes('150') || n.includes('250') || n.includes('500') || n.includes('1MM'));
            });
            filteredPlans.sort((a,b) => b.basePrice - a.basePrice); 
        } else {
            filteredPlans = allPlans.filter(p => {
                const n = p.nome.toUpperCase();
                return (n.includes('30') || n.includes('60') || n.includes('100')) && !n.includes('1MM');
            });
            filteredPlans.sort((a,b) => a.basePrice - b.basePrice); 
        }

        if (filteredPlans.length === 0) filteredPlans = allPlans;
        filteredPlans = filteredPlans.slice(0, 6);

        // 5. Cálculo Final de Preço (Base + Agravo Idade + Comissão)
        const finalPlans = filteredPlans.map(p => ({
            ...p,
            totalPrice: calculateFinalPrice(p.basePrice, idades, commissionRate),
            covid: 'USD 10.000'
        }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: finalPlans }) };

    } catch (e) {
        console.error("Exception em handleGetPlans:", e);
        return { 
            statusCode: 500, 
            headers: HEADERS, 
            body: JSON.stringify({ error: `Falha na Cotação: ${e.message}` }) 
        };
    }
}

// --- CÁLCULO DE PREÇO ---
function calculateFinalPrice(basePrice, ages, commissionRate = 0) {
    let total = 0;
    const priceWithCommission = basePrice * (1 + (commissionRate / 100));

    ages.forEach(age => {
        const idade = parseInt(age);
        let multiplier = 1.0; 
        if (idade >= 66 && idade <= 70) multiplier = 1.25; 
        else if (idade >= 71 && idade <= 80) multiplier = 2.00; 
        else if (idade >= 81 && idade <= 85) multiplier = 3.00; 
        
        total += (priceWithCommission * multiplier);
    });
    return total;
}

// --- 2. PAGAMENTO E EMISSÃO ---
async function handlePaymentAndEmission(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName, contactPhone, tripReason } = data;

    // A. Dispatcher (ModoSegu)
    const modoSeguPayload = {
        "tenant_id": "RODQ19",
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
            "amount_cents": Math.round(amountBRL * 100), 
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

    let paymentStatus = 'failed';
    let errorMessage = '';

    try {
        const response = await fetch(MODOSEGU_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modoSeguPayload)
        });
        
        if (response.ok) {
            paymentStatus = 'succeeded';
        } else {
            const errJson = await response.json();
            paymentStatus = 'failed';
            errorMessage = errJson.error?.message || errJson.error || "Pagamento recusado. Verifique os dados.";
        }
    } catch (err) { 
        console.error("Erro Conexão Dispatcher:", err);
        return { 
            statusCode: 500, 
            headers: HEADERS, 
            body: JSON.stringify({ error: "Erro de comunicação com o gateway de pagamento. Tente novamente." }) 
        };
    }

    if (paymentStatus !== 'succeeded') {
        return { 
            statusCode: 400, 
            headers: HEADERS, 
            body: JSON.stringify({ error: errorMessage }) 
        };
    }

    // B. Emissão Real na Coris
    let voucherCode = '';
    let emissionStatus = 'emitido';
    let emissionError = null;

    try {
        voucherCode = await emitirCorisReal(data);
        console.log(`Voucher emitido: ${voucherCode}`);
    } catch (e) {
        console.error("Erro Emissão Coris:", e.message);
        emissionStatus = 'erro_emissao'; 
        emissionError = e.message;
        voucherCode = 'EMISSAO_PENDENTE'; 
    }

    // C. Persistência
    if (supabase) {
        await supabase.from('remessaonlinesioux_leads').update({
            status: emissionStatus,
            valor_total: amountBRL,
            plano_nome: planName,
            coris_voucher: voucherCode,
            motivo_viagem: tripReason,
            coris_response_xml: emissionError || 'Sucesso'
        }).eq('id', leadId);
    }

    let userMessage = "Pagamento Aprovado! Sua apólice foi emitida e enviada por e-mail.";
    if (emissionStatus === 'erro_emissao') {
        userMessage = "Pagamento Aprovado! Porém, houve uma instabilidade momentânea na geração do voucher. Nossa equipe emitirá sua apólice manualmente em breve.";
    }

    return {
        statusCode: 200, 
        headers: HEADERS, 
        body: JSON.stringify({ success: true, voucher: voucherCode, message: userMessage })
    };
}

// --- FUNÇÃO AUXILIAR: EMISSÃO XML CORIS (FORMATO RÍGIDO) ---
async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    
    // Formatar datas para YYYY/MM/DD
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/');
    const dtInicio = formatDate(dates.start);
    const dtFim = formatDate(dates.end);
    
    // Limpeza
    const cleanStr = (s) => s ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() : "";
    const cleanNum = (n) => n ? n.replace(/\D/g, '') : "";

    let xmlContent = '';
    const soapAction = passengers.length === 1 ? 'InsereVoucherIndividualV13' : 'InsereVoucherFamiliarV13';

    // Montagem da String XML em linha única para evitar quebras
    if (passengers.length === 1) {
        const p = passengers[0];
        // Nota: Removidas quebras de linha dentro do <execute>
        xmlContent = `<execute><param name='login' value='${CORIS_CONFIG.login}' /><param name='senha' value='${CORIS_CONFIG.senha}' /><param name='idplano' value='${planId}' /><param name='qtdpaxes' value='1' /><param name='familiar' value='N' /><param name='inicioviagem' value='${dtInicio}' /><param name='fimviagem' value='${dtFim}' /><param name='destino' value='${data.destination || 4}' /><param name='nome' value='${cleanStr(p.nome.split(' ')[0])}' /><param name='sobrenome' value='${cleanStr(p.nome.split(' ').slice(1).join(' '))}' /><param name='sexo' value='${p.sexo}' /><param name='dtnascimento' value='${formatDate(p.nascimento)}' /><param name='documento' value='${cleanNum(p.cpf)}' /><param name='tipodoc' value='CPF' /><param name='endereco' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='telefone' value='${cleanNum(contactPhone)}' /><param name='cidade' value='${cleanStr(comprador.endereco.cidade)}' /><param name='uf' value='${comprador.endereco.uf}' /><param name='cep' value='${cleanNum(comprador.endereco.cep)}' /><param name='contatonome' value='${cleanStr(data.contactName || comprador.nome)}' /><param name='contatofone' value='${cleanNum(contactPhone)}' /><param name='contatoendereco' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='formapagamento' value='FA' /><param name='processo' value='0' /><param name='meio' value='0' /><param name='email' value='${comprador.email}' /><param name='angola' value='N' /><param name='categoria' value='1' /><param name='valorvenda' value='00.00' /><param name='codigofree' value='' /></execute>`;
    } else {
        // FAMILIAR / GRUPO
        let paxParams = '';
        passengers.forEach((p, idx) => {
            const i = idx + 1;
            paxParams += `<param name='nome${i}' value='${cleanStr(p.nome.split(' ')[0])}' /><param name='sobrenome${i}' value='${cleanStr(p.nome.split(' ').slice(1).join(' '))}' /><param name='sexo${i}' value='${p.sexo}' /><param name='dtnascimento${i}' value='${formatDate(p.nascimento)}' /><param name='documento${i}' value='${cleanNum(p.cpf)}' /><param name='tipodoc${i}' value='CPF' /><param name='file${i}' value='' /><param name='endereco${i}' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='telefone${i}' value='${cleanNum(contactPhone)}' /><param name='cidade${i}' value='${cleanStr(comprador.endereco.cidade)}' /><param name='uf${i}' value='${comprador.endereco.uf}' /><param name='cep${i}' value='${cleanNum(comprador.endereco.cep)}' /><param name='bairro${i}' value='${cleanStr(comprador.endereco.bairro)}' /><param name='numero${i}' value='${comprador.endereco.numero}' /><param name='endcomplemento${i}' value='${cleanStr(comprador.endereco.complemento || '')}' /><param name='voucherCreditoPax${i}' value='' />`;
        });
        
        for(let k = passengers.length + 1; k <= 6; k++) {
             paxParams += `<param name='nome${k}' value='' /><param name='sobrenome${k}' value='' /><param name='sexo${k}' value='' /><param name='dtnascimento${k}' value='' /><param name='documento${k}' value='' /><param name='tipodoc${k}' value='' /><param name='file${k}' value='' /><param name='endereco${k}' value='' /><param name='telefone${k}' value='' /><param name='cidade${k}' value='' /><param name='uf${k}' value='' /><param name='cep${k}' value='' /><param name='bairro${k}' value='' /><param name='numero${k}' value='' /><param name='endcomplemento${k}' value='' /><param name='voucherCreditoPax${k}' value='' />`;
        }

        xmlContent = `<execute><param name='login' value='${CORIS_CONFIG.login}' /><param name='senha' value='${CORIS_CONFIG.senha}' /><param name='idplano' value='${planId}' /><param name='qtdpaxes' value='${passengers.length}' /><param name='inicioviagem' value='${dtInicio}' /><param name='fimviagem' value='${dtFim}' /><param name='destino' value='${data.destination || 4}' />${paxParams}<param name='contatonome' value='${cleanStr(data.contactName || comprador.nome)}' /><param name='contatofone' value='${cleanNum(contactPhone)}' /><param name='contatoendereco' value='${cleanStr(comprador.endereco.logradouro)}' /><param name='formapagamento' value='FA' /><param name='processo' value='0' /><param name='meio' value='0' /><param name='email' value='${comprador.email}' /><param name='angola' value='N' /><param name='morteac' value='0' /><param name='mortenat' value='0' /><param name='esportes' value='0' /><param name='bagagens' value='0' /><param name='cancplus' value='0' /><param name='cancany' value='0' /><param name='furtoelet' value='0' /><param name='categoria' value='1' /><param name='valorvenda' value='00.00' /><param name='codigofree' value='' /><param name='danosmala' value='0' /><param name='pet' value='0' /><param name='dataitemviagem' value='' /><param name='p1' value='0' /><param name='p2' value='0' /><param name='p3' value='0' /></execute>`;
    }

    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${soapAction} xmlns="http://tempuri.org/"><strXML><![CDATA[${xmlContent}]]></strXML></${soapAction}></soap:Body></soap:Envelope>`;

    const response = await fetch(CORIS_CONFIG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/${soapAction}` },
        body: soapEnvelope
    });

    const rawText = await response.text();
    const cleanResponse = decodeHtmlEntities(rawText);

    // Tentativa 1: Extrair Voucher
    const match = cleanResponse.match(/<voucher>(.*?)<\/voucher>/i);
    if (match && match[1] && match[1].trim() !== '') return match[1];

    // Tentativa 2: Extrair Erro
    const errMatch = cleanResponse.match(/<erro>(.*?)<\/erro>/i);
    const errCode = errMatch ? errMatch[1] : null;
    
    if (errCode && errCode !== '0') {
        throw new Error(`Coris recusou emissão: Código de Erro ${errCode}.`);
    }
    
    throw new Error("Falha na emissão: Resposta da Seguradora ilegível ou sem número de voucher.");
}
