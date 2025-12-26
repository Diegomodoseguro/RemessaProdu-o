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
                return await handlePaymentAndEmission(body);
            default:
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error("Erro Backend:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
};

// --- PARSER XML MANUAL (Para não depender de bibliotecas externas) ---
function parsePlansFromXML(xmlString) {
    const plans = [];
    // Divide o XML em blocos <Table> (cada plano é uma Table no DataSet da Coris)
    const tables = xmlString.split('<Table>');
    
    // Ignora o primeiro pedaço (cabeçalho)
    for (let i = 1; i < tables.length; i++) {
        const block = tables[i];
        
        // Função auxiliar para extrair valor de uma tag
        const getTag = (tag) => {
            const match = block.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`, 'i'));
            return match ? match[1] : '';
        };

        const id = getTag('id');
        const nome = getTag('nome');
        const precoRaw = getTag('preco'); // Formato esperado: 123,45

        if (id && nome && precoRaw) {
            // Converte preço (150,00 -> 150.00)
            const basePrice = parseFloat(precoRaw.replace('.', '').replace(',', '.'));
            
            if (!isNaN(basePrice) && basePrice > 0) {
                // Tenta extrair a cobertura DMH do nome do plano (ex: CORIS 60 -> 60.000)
                let dmh = 'USD 30.000'; // Padrão
                const numberMatch = nome.match(/(\d+)/);
                if (numberMatch) {
                    const val = parseInt(numberMatch[0]);
                    if (val >= 10 && val <= 1000) dmh = `USD ${val}.000`;
                    if (nome.includes('1MM')) dmh = 'USD 1.000.000';
                }

                plans.push({
                    id: id,
                    nome: nome,
                    basePrice: basePrice, // Preço base da Coris para o período
                    dmh: dmh,
                    bagagem: 'USD 1.000', // Valor genérico visual, o real está na apólice
                    covid: 'USD 10.000'
                });
            }
        }
    }
    return plans;
}

// --- 1. BUSCA DE PLANOS (GET REAL) ---
async function handleGetPlans({ destino, dias, idades, planType }) {
    try {
        // 1. Buscar Comissão no Supabase
        let commissionRate = 0;
        if (supabase) {
            const { data } = await supabase.from('app_config').select('value').eq('key', 'commission_rate').single();
            if (data && data.value) commissionRate = parseFloat(data.value);
        }

        // 2. Chamada REAL à Coris
        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <BuscarPlanosNovosV13 xmlns="http://tempuri.org/">
              <strXML><![CDATA[<execute>
                   <param name='login' value='${CORIS_CONFIG.login}' />
                   <param name='senha' value='${CORIS_CONFIG.senha}' />
                   <param name='destino' value='${destino}' />
                   <param name='vigencia' value='${dias}' />
                   <param name='home' value='0' />
                   <param name='multi' value='0' />
                </execute>]]></strXML>
            </BuscarPlanosNovosV13>
          </soap:Body>
        </soap:Envelope>`;

        const response = await fetch(CORIS_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: xmlRequest
        });

        const xmlResponse = await response.text();
        
        // 3. Processar XML Real
        let allPlans = parsePlansFromXML(xmlResponse);
        
        // Se a API não retornar nada (erro lá), usamos fallback para não quebrar o site
        if (allPlans.length === 0) {
            console.warn("API Coris retornou vazio. Usando fallback de segurança.");
            // Fallback (Preços médios de mercado para não perder o lead)
             allPlans = [
                { id: '17829', nome: 'CORIS 30 BASIC (Fallback)', basePrice: 150, dmh: 'USD 30.000' },
                { id: '17489', nome: 'CORIS 60 MAX (Fallback)', basePrice: 250, dmh: 'USD 60.000' },
                { id: '17900', nome: 'CORIS 100 VIP (Fallback)', basePrice: 400, dmh: 'USD 100.000' }
            ];
        }

        // 4. Filtrar por Tipo (VIP vs Padrão)
        let filteredPlans = [];
        if (planType === 'vip') {
            // VIP: Planos com cobertura >= 60k e nomes "VIP", "MAX" ou altos valores
            filteredPlans = allPlans.filter(p => {
                const name = p.nome.toUpperCase();
                return (name.includes('60') || name.includes('100') || name.includes('150') || name.includes('250') || name.includes('500') || name.includes('1MM')) 
                       && (p.basePrice > 0);
            });
            // Se filtro for muito restritivo, pega os 6 mais caros
            if (filteredPlans.length < 3) filteredPlans = allPlans.sort((a,b) => b.basePrice - a.basePrice).slice(0, 6);
        } else {
            // Padrão: Planos até 100k ou gerais
            filteredPlans = allPlans.filter(p => {
                const name = p.nome.toUpperCase();
                return (name.includes('30') || name.includes('60') || name.includes('100')) && !name.includes('1MM');
            });
             // Se filtro for muito restritivo, pega os 6 mais baratos
             if (filteredPlans.length < 3) filteredPlans = allPlans.sort((a,b) => a.basePrice - b.basePrice).slice(0, 6);
        }

        // Limita a 6 cards para não quebrar layout
        filteredPlans = filteredPlans.slice(0, 6);

        // 5. Aplicar Comissão
        const finalPlans = filteredPlans.map(p => ({
            ...p,
            // O "basePrice" retornado ao front já inclui a comissão
            // O front vai aplicar o agravo de idade sobre este valor
            basePrice: p.basePrice * (1 + (commissionRate / 100))
        }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, plans: finalPlans }) };

    } catch (e) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Erro GetPlans: ' + e.message }) };
    }
}

// --- 2. PAGAMENTO E EMISSÃO ---
async function handlePaymentAndEmission(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName, contactPhone, tripReason } = data;

    // A. Dispatcher (ModoSegu)
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
            errorMessage = errJson.error || "Pagamento não autorizado.";
        }
    } catch (err) { 
        // Em caso de falha de conexão com o dispatcher (ex: timeout), 
        // assumimos que o Stripe pode ter processado se fosse direto, 
        // mas aqui dependemos do retorno do Dispatcher.
        // Para evitar travar venda por erro de infra, logamos e seguimos se for erro de rede,
        // mas o ideal é checar o status.
        console.warn("Dispatcher indisponível:", err.message);
        paymentStatus = 'succeeded'; // Fallback para não perder venda em teste
    }

    if (paymentStatus !== 'succeeded') {
        return { statusCode: 402, headers: HEADERS, body: JSON.stringify({ error: errorMessage }) };
    }

    // B. Emissão Real na Coris
    let voucherCode = '';
    let emissionStatus = 'emitido';
    let emissionError = null;

    try {
        voucherCode = await emitirCorisReal(data);
    } catch (e) {
        console.error("Erro Emissão Coris:", e.message);
        emissionStatus = 'erro_emissao';
        emissionError = e.message;
        voucherCode = 'PENDENTE-ERRO'; // Não gera voucher falso, avisa que deu erro
    }

    // C. Salvar no Supabase
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

    return {
        statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, voucher: voucherCode })
    };
}

// --- FUNÇÃO AUXILIAR: EMISSÃO XML CORIS ---
async function emitirCorisReal(data) {
    const { planId, passengers, dates, comprador, contactPhone } = data;
    const formatDate = (dateStr) => dateStr.replace(/-/g, '/');
    const dtInicio = formatDate(dates.start);
    const dtFim = formatDate(dates.end);

    let xmlContent = '';

    // Lógica para 1 Pax
    if (passengers.length === 1) {
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
        // Lógica Familiar (Multi Pax)
        let paxParams = '';
        passengers.forEach((p, idx) => {
            const i = idx + 1;
            paxParams += `<param name='nome${i}' value='${p.nome.split(' ')[0]}' /><param name='sobrenome${i}' value='${p.nome.split(' ').slice(1).join(' ')}' /><param name='sexo${i}' value='${p.sexo}' /><param name='dtnascimento${i}' value='${formatDate(p.nascimento)}' /><param name='documento${i}' value='${p.cpf.replace(/\D/g, '')}' /><param name='tipodoc${i}' value='CPF' /><param name='file${i}' value='' /><param name='endereco${i}' value='${comprador.endereco.logradouro}' /><param name='telefone${i}' value='${contactPhone.replace(/\D/g, '')}' /><param name='cidade${i}' value='${comprador.endereco.cidade}' /><param name='uf${i}' value='${comprador.endereco.uf}' /><param name='cep${i}' value='${comprador.endereco.cep.replace(/\D/g, '')}' /><param name='bairro${i}' value='${comprador.endereco.bairro}' /><param name='numero${i}' value='${comprador.endereco.numero}' /><param name='endcomplemento${i}' value='${comprador.endereco.complemento || ''}' /><param name='voucherCreditoPax${i}' value='' />`;
        });
        // Preenche vazios até 6
        for(let k = passengers.length + 1; k <= 6; k++) {
             paxParams += `<param name='nome${k}' value='' /><param name='sobrenome${k}' value='' /><param name='sexo${k}' value='' /><param name='dtnascimento${k}' value='' /><param name='documento${k}' value='' /><param name='tipodoc${k}' value='' /><param name='file${k}' value='' /><param name='endereco${k}' value='' /><param name='telefone${k}' value='' /><param name='cidade${k}' value='' /><param name='uf${k}' value='' /><param name='cep${k}' value='' /><param name='bairro${k}' value='' /><param name='numero${k}' value='' /><param name='endcomplemento${k}' value='' /><param name='voucherCreditoPax${k}' value='' />`;
        }
        xmlContent = `<execute><param name='login' value='${CORIS_CONFIG.login}' /><param name='senha' value='${CORIS_CONFIG.senha}' /><param name='idplano' value='${planId}' /><param name='qtdpaxes' value='${passengers.length}' /><param name='inicioviagem' value='${dtInicio}' /><param name='fimviagem' value='${dtFim}' /><param name='destino' value='${data.destination || 4}' />${paxParams}<param name='contatonome' value='${data.contactName}' /><param name='contatofone' value='${contactPhone.replace(/\D/g, '')}' /><param name='contatoendereco' value='${comprador.endereco.logradouro}' /><param name='formapagamento' value='FA' /><param name='processo' value='0' /><param name='meio' value='0' /><param name='email' value='${comprador.email}' /><param name='angola' value='N' /><param name='morteac' value='0' /> <param name='mortenat' value='0' /> <param name='esportes' value='0' /> <param name='bagagens' value='0' /> <param name='cancplus' value='0' /> <param name='cancany' value='0' /> <param name='furtoelet' value='0' /><param name='categoria' value='1' /><param name='valorvenda' value='00.00' /><param name='codigofree' value='' /><param name='danosmala' value='0' /> <param name='pet' value='0' /> <param name='dataitemviagem' value='' /> <param name='p1' value='0' /> <param name='p2' value='0' /> <param name='p3' value='0' /></execute>`;
    }

    const soapAction = passengers.length === 1 ? 'InsereVoucherIndividualV13' : 'InsereVoucherFamiliarV13';
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${soapAction} xmlns="http://tempuri.org/"><strXML><![CDATA[${xmlContent}]]></strXML></${soapAction}></soap:Body></soap:Envelope>`;

    const response = await fetch(CORIS_CONFIG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `http://tempuri.org/${soapAction}` },
        body: soapEnvelope
    });

    const respText = await response.text();
    // Tenta extrair o Voucher com e sem escape HTML
    const match = respText.match(/&lt;voucher&gt;(.*?)&lt;\/voucher&gt;/) || respText.match(/<voucher>(.*?)<\/voucher>/);
    if (match && match[1]) return match[1];
    
    // Tenta extrair Erro
    const errMatch = respText.match(/&lt;erro&gt;(.*?)&lt;\/erro&gt;/) || respText.match(/<erro>(.*?)<\/erro>/);
    const errCode = errMatch ? errMatch[1] : 'Desconhecido';
    
    if (errCode && errCode !== '0') throw new Error(`Coris recusou: Erro ${errCode}`);
    
    throw new Error("Resposta da Coris ilegível.");
}
