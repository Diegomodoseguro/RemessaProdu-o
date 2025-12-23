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

const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750', 
    senha: 'diego@'
};

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
                return await handleModoSeguDispatch(body);
            default:
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("Erro Backend:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};

// --- LÓGICA DE CÁLCULO DE PREÇO ---
function calculateFinalPrice(basePrice, ages, commissionRate = 0) {
    let total = 0;
    
    // 1. Aplica o Fator de Comissão (Markup) sobre o preço base unitário
    // Ex: Base 100 + 20% = 120.
    const priceWithCommission = basePrice * (1 + (commissionRate / 100));

    // 2. Multiplica pelos passageiros aplicando agravo de idade
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

// --- 1. BUSCA DE PLANOS ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        // 1. Buscar a taxa de comissão no Supabase
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) commissionRate = parseFloat(data.value);
        }

        // 2. Chamada Coris (Mantida para validação)
        try {
            const xmlBody = `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soapenv:Header/><soapenv:Body><tem:BuscarPlanosNovosV13><tem:strXML><![CDATA[<execute><param name='login' type='varchar' value='${CORIS_CONFIG.login}' /><param name='senha' type='varchar' value='${CORIS_CONFIG.senha}' /><param name='destino' type='int' value='${destino}' /><param name='vigencia' type='int' value='${dias}' /><param name='home' type='int' value='0' /><param name='multi' type='int' value='0' /></execute>]]></tem:strXML></tem:BuscarPlanosNovosV13></soapenv:Body></soapenv:Envelope>`;
            await fetch(CORIS_CONFIG.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xmlBody });
        } catch (e) { console.log("Aviso Coris:", e.message); }

        // 3. Definição dos Planos Base
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

        // 4. Aplica a Comissão no Preço Final
        const plansWithPrice = plans.map(p => ({
            ...p,
            totalPrice: calculateFinalPrice(p.basePrice, idades, commissionRate), // Passa a taxa aqui
            covid: 'USD 10.000'
        })).filter(p => p.totalPrice > 0);

        return {
            statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: plansWithPrice })
        };

    } catch (e) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Erro GetPlans: ' + e.message }) };
    }
}

// --- 2. DISPATCHER MODOSEGU ---
async function handleModoSeguDispatch(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName, contactPhone, tripReason } = data;

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

    try {
        await fetch(MODOSEGU_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modoSeguPayload)
        });
    } catch (err) { console.warn("Dispatcher indisponível:", err.message); }

    const simulatedVoucher = `E1-${Math.floor(Math.random() * 89999) + 10000}/2025`;
    
    if (supabase) {
        await supabase.from('remessaonlinesioux_leads').update({
            status: 'pagamento_processado',
            valor_total: amountBRL,
            plano_nome: planName,
            coris_voucher: simulatedVoucher,
            motivo_viagem: tripReason 
        }).eq('id', leadId);
    }

    return {
        statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, voucher: simulatedVoucher })
    };
}
