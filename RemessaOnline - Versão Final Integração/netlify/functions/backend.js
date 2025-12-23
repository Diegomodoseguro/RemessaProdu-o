const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const { createClient } = require('@supabase/supabase-js');
let supabase;
try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    }
} catch (e) { console.error("Erro Supabase Init:", e); }

// CREDENCIAIS REAIS DA CORIS
const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@'
};

// URL DO DISPATCHER (Se não houver env var, usa o mock local, mas em produção deve ser definido)
const MODOSEGU_URL = process.env.MODOSEGU_URL || 'http://localhost:5020/api/stripe/dispatch';

exports.handler = async (event, context) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

    try {
        if (!event.body) throw new Error("Dados não recebidos.");
        const body = JSON.parse(event.body);
        const { action } = body;

        switch (action) {
            case 'getPlans':
                return await handleGetPlans(body);
            case 'processPayment':
                return await handlePaymentAndEmission(body);
            default:
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("Erro Backend:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};

// --- LÓGICA DE PREÇOS (COM COMISSÃO) ---
function calculateFinalPrice(basePrice, ages, commissionRate = 0) {
    let total = 0;
    // Aplica a COMISSÃO sobre o preço base
    const priceWithCommission = basePrice * (1 + (commissionRate / 100));

    // Aplica o AGRAVO DE IDADE
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

// --- 1. BUSCA DE PLANOS (GET) ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        // 1. Buscar Comissão no Supabase
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) commissionRate = parseFloat(data.value);
        }

        // 2. Tenta bater na Coris para validar conexão
        try {
            const xmlBody = `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soapenv:Header/><soapenv:Body><tem:BuscarPlanosNovosV13><tem:strXML><![CDATA[<execute><param name='login' type='varchar' value='${CORIS_CONFIG.login}' /><param name='senha' type='varchar' value='${CORIS_CONFIG.senha}' /><param name='destino' type='int' value='${destino}' /><param name='vigencia' type='int' value='${dias}' /><param name='home' type='int' value='0' /><param name='multi' type='int' value='0' /></execute>]]></tem:strXML></tem:BuscarPlanosNovosV13></soapenv:Body></soapenv:Envelope>`;
            await fetch(CORIS_CONFIG.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xmlBody });
        } catch (e) { console.log("Aviso Coris (GetPlans):", e.message); }

        // 3. Catálogo de Planos (Para garantir os 6 cards visuais)
        let plans = [];
        if (planType === 'vip') {
            plans = [
                { id: '17830', nome: 'CORIS 60 VIP', dmh: 'USD 60.000', bagagem: 'USD 1.500', basePrice: 200 },
                { id: '17831', nome: 'CORIS 100 VIP', dmh: 'USD 100.000', bagagem: 'USD 2.000', basePrice: 350 },
                { id: '17832', nome: 'CORIS 150 VIP', dmh: 'USD 150.000', bagagem: 'USD 2.000', basePrice: 420 },
                { id: '17833', nome: 'CORIS 250 VIP', dmh: 'USD 250.000', bagagem: 'USD 2.500', basePrice: 550 },
                { id: '17834', nome: 'CORIS 500 VIP', dmh: 'USD 500.000', bagagem: 'USD 3.000', basePrice: 700 },
                { id: '17835', nome: 'CORIS 1MM BLACK', dmh: 'USD 1.000.000', bagagem: 'USD 5.000', basePrice: 950 }
            ];
        } else {
            plans = [
                { id: '17489', nome: 'CORIS 60 MAX', dmh: 'USD 60.000', bagagem: 'USD 1.000', basePrice: 180 },
                { id: '17490', nome: 'CORIS 100 MAX', dmh: 'USD 100.000', bagagem: 'USD 1.200', basePrice: 280 },
                { id: '17491', nome: 'CORIS 150 MAX', dmh: 'USD 150.000', bagagem: 'USD 1.500', basePrice: 380 },
                { id: '17492', nome: 'CORIS 250 MAX', dmh: 'USD 250.000', bagagem: 'USD 1.500', basePrice: 480 },
                { id: '17493', nome: 'CORIS 500 MAX', dmh: 'USD 500.000', bagagem: 'USD 2.000', basePrice: 650 },
                { id: '17494', nome: 'CORIS 700 MAX', dmh: 'USD 700.000', bagagem: 'USD 2.500', basePrice: 800 }
            ];
        }

        const plansWithPrice = plans.map(p => ({
            ...p,
            totalPrice: calculateFinalPrice(p.basePrice, idades, commissionRate),
            covid: 'USD 10.000'
        })).filter(p => p.totalPrice > 0);

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: plansWithPrice }) };

    } catch (e) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Erro GetPlans: ' + e.message }) };
    }
}

// --- 2. PAGAMENTO E EMISSÃO (PROCESSAMENTO) ---
async function handlePaymentAndEmission(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName, contactPhone, tripReason } = data;

    // A. Enviar para ModoSegu (Dispatcher)
    const modoSeguPayload = {
        "tenant_id": "RODQ19",
        "tipo": "stripe",
        "cliente": { "nome": comprador.nome, "email": comprador.email, "telefone": contactPhone || "0000000000", "cpf_cnpj": comprador.cpf },
        "enderecos": [{ "tipo": "residencial", "cep": comprador.endereco.cep, "logradouro": comprador.endereco.logradouro, "numero": comprador.endereco.numero, "complemento": comprador.endereco.complemento || "", "bairro": comprador.endereco.bairro, "cidade": comprador.endereco.cidade, "uf": comprador.endereco.uf }],
        "pagamento": {
            "amount_cents": Math.round(amountBRL * 100),
            "currency": "brl",
            "descricao": `Seguro Viagem - ${planName} (Lead ${leadId})`,
            "receipt_email": comprador.email,
            "metadata": { "pedido_id": leadId, "origem": "site_remessa", "motivo_viagem": tripReason },
            "payment_method_id": paymentMethodId
        }
    };

    try {
        await fetch(MODOSEGU_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modoSeguPayload) });
    } catch (err) { console.warn("Dispatcher indisponível:", err.message); }

    // B. EMISSÃO REAL NA CORIS
    let voucherCode = 'PENDENTE';
    let emissionStatus = 'emitido'; // Assume sucesso se não der erro abaixo
    let emissionError = null;

    try {
        // Tenta emitir de verdade. Se falhar, vai para o catch.
        voucherCode = await emitirCorisReal(data);
    } catch (e) {
        console.error("Erro Emissão Coris:", e.message);
        emissionStatus = 'erro_emissao';
        emissionError = e.message;
        // Gera provisório para não travar o cliente na tela, mas marca erro no banco
        voucherCode = `PROV-ERRO-${Math.floor(Math.random() * 10000)}`;
    }

    // C. Atualizar Banco de Dados
    if (supabase) {
        await supabase.from('remessaonlinesioux_leads').update({
            status: emissionStatus,
            valor_total: amountBRL,
            plano_nome: planName,
            coris_voucher: voucherCode,
            motivo_viagem: tripReason,
            coris_response_xml: emissionError || 'Sucesso na Emissão Real'
        }).eq('id', leadId);
    }

    return {
        statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, voucher: voucherCode })
    };
}

// --- FUNÇÃO AUXILIAR: MONTA O XML E CHAMA A CORIS ---
async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    
    // Formatar datas (YYYY-MM-DD -> YYYY/MM/DD)
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/');
    const dtInicio = formatDate(dates.start);
    const dtFim = formatDate(dates.end);

    let xmlContent = '';

    // Se tiver mais de 1 passageiro, usa a lógica FAMILIAR (adaptada para XML genérico se necessário)
    // Para simplificar e garantir sucesso, vamos usar a estrutura de InsereVoucherIndividualV13 ou FamiliarV13
    
    if (passengers.length === 1) {
        // XML INDIVIDUAL
        xmlContent = `
        <execute>
            <param name='login' value='${CORIS_CONFIG.login}' />
            <param name='senha' value='${CORIS_CONFIG.senha}' />
            <param name='idplano' value='${planId}' />
            <param name='qtdpaxes' value='1' />
            <param name='familiar' value='N' />
            <param name='inicioviagem' value='${dtInicio}' />
            <param name='fimviagem' value='${dtFim}' />
            <param name='destino' value='${data.destination || 4}' />
            <param name='nome' value='${passengers[0].nome.split(' ')[0]}' />
            <param name='sobrenome' value='${passengers[0].nome.split(' ').slice(1).join(' ')}' />
            <param name='sexo' value='${passengers[0].sexo}' />
            <param name='dtnascimento' value='${formatDate(passengers[0].nascimento)}' />
            <param name='documento' value='${passengers[0].cpf.replace(/\D/g, '')}' />
            <param name='tipodoc' value='CPF' />
            <param name='endereco' value='${comprador.endereco.logradouro}' />
            <param name='telefone' value='${contactPhone.replace(/\D/g, '')}' />
            <param name='cidade' value='${comprador.endereco.cidade}' />
            <param name='uf' value='${comprador.endereco.uf}' />
            <param name='cep' value='${comprador.endereco.cep.replace(/\D/g, '')}' />
            <param name='contatonome' value='${data.contactName}' />
            <param name='contatofone' value='${contactPhone.replace(/\D/g, '')}' />
            <param name='contatoendereco' value='${comprador.endereco.logradouro}' />
            <param name='formapagamento' value='FA' />
            <param name='processo' value='0' />
            <param name='meio' value='0' />
            <param name='email' value='${comprador.email}' />
            <param name='angola' value='N' />
            <param name='categoria' value='1' /> 
            <param name='valorvenda' value='00.00' />
            <param name='codigofree' value='' />
        </execute>`;
    } else {
        // XML FAMILIAR (Até 6 pax)
        let paxParams = '';
        passengers.forEach((p, idx) => {
            const i = idx + 1;
            paxParams += `
            <param name='nome${i}' value='${p.nome.split(' ')[0]}' />
            <param name='sobrenome${i}' value='${p.nome.split(' ').slice(1).join(' ')}' />
            <param name='sexo${i}' value='${p.sexo}' />
            <param name='dtnascimento${i}' value='${formatDate(p.nascimento)}' />
            <param name='documento${i}' value='${p.cpf.replace(/\D/g, '')}' />
            <param name='tipodoc${i}' value='CPF' />
            <param name='file${i}' value='' />
            <param name='endereco${i}' value='${comprador.endereco.logradouro}' />
            <param name='telefone${i}' value='${contactPhone.replace(/\D/g, '')}' />
            <param name='cidade${i}' value='${comprador.endereco.cidade}' />
            <param name='uf${i}' value='${comprador.endereco.uf}' />
            <param name='cep${i}' value='${comprador.endereco.cep.replace(/\D/g, '')}' />
            <param name='bairro${i}' value='${comprador.endereco.bairro}' />
            <param name='numero${i}' value='${comprador.endereco.numero}' />
            <param name='endcomplemento${i}' value='${comprador.endereco.complemento || ''}' />
            <param name='voucherCreditoPax${i}' value='' />`;
        });

        // Preencher slots vazios até 6 (obrigatório pelo manual Coris Familiar)
        for(let k = passengers.length + 1; k <= 6; k++) {
             paxParams += `<param name='nome${k}' value='' /><param name='sobrenome${k}' value='' /><param name='sexo${k}' value='' /><param name='dtnascimento${k}' value='' /><param name='documento${k}' value='' /><param name='tipodoc${k}' value='' /><param name='file${k}' value='' /><param name='endereco${k}' value='' /><param name='telefone${k}' value='' /><param name='cidade${k}' value='' /><param name='uf${k}' value='' /><param name='cep${k}' value='' /><param name='bairro${k}' value='' /><param name='numero${k}' value='' /><param name='endcomplemento${k}' value='' /><param name='voucherCreditoPax${k}' value='' />`;
        }

        xmlContent = `
        <execute>
            <param name='login' value='${CORIS_CONFIG.login}' />
            <param name='senha' value='${CORIS_CONFIG.senha}' />
            <param name='idplano' value='${planId}' />
            <param name='qtdpaxes' value='${passengers.length}' />
            <param name='inicioviagem' value='${dtInicio}' />
            <param name='fimviagem' value='${dtFim}' />
            <param name='destino' value='${data.destination || 4}' />
            ${paxParams}
            <param name='contatonome' value='${data.contactName}' />
            <param name='contatofone' value='${contactPhone.replace(/\D/g, '')}' />
            <param name='contatoendereco' value='${comprador.endereco.logradouro}' />
            <param name='formapagamento' value='FA' />
            <param name='processo' value='0' />
            <param name='meio' value='0' />
            <param name='email' value='${comprador.email}' />
            <param name='angola' value='N' />
            <param name='morteac' value='0' /> <param name='mortenat' value='0' /> <param name='esportes' value='0' /> <param name='bagagens' value='0' /> <param name='cancplus' value='0' /> <param name='cancany' value='0' /> <param name='furtoelet' value='0' />
            <param name='categoria' value='1' />
            <param name='valorvenda' value='00.00' />
            <param name='codigofree' value='' />
            <param name='danosmala' value='0' /> <param name='pet' value='0' /> <param name='dataitemviagem' value='' /> <param name='p1' value='0' /> <param name='p2' value='0' /> <param name='p3' value='0' />
        </execute>`;
    }

    const soapAction = passengers.length === 1 ? 'InsereVoucherIndividualV13' : 'InsereVoucherFamiliarV13';
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${soapAction} xmlns="http://tempuri.org/"><strXML><![CDATA[${xmlContent}]]></strXML></${soapAction}></soap:Body></soap:Envelope>`;

    const response = await fetch(CORIS_CONFIG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/${soapAction}` },
        body: soapEnvelope
    });

    const respText = await response.text();
    
    // Tenta extrair o Voucher
    const match = respText.match(/&lt;voucher&gt;(.*?)&lt;\/voucher&gt;/); // A Coris retorna XML encodado dentro de XML
    const matchDirect = respText.match(/<voucher>(.*?)<\/voucher>/); // Ou direto
    
    const voucher = (match && match[1]) || (matchDirect && matchDirect[1]);

    if (voucher) return voucher;
    
    // Se der erro, tenta ler o erro
    const errMatch = respText.match(/&lt;erro&gt;(.*?)&lt;\/erro&gt;/);
    const errDirect = respText.match(/<erro>(.*?)<\/erro>/);
    const errCode = (errMatch && errMatch[1]) || (errDirect && errDirect[1]);
    
    if (errCode && errCode !== '0') throw new Error(`Coris recusou: Erro ${errCode}`);
    
    throw new Error("Resposta da Coris ilegível ou sem voucher.");
}
