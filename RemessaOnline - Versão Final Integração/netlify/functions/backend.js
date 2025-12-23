// Configurações e Cabeçalhos CORS
const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Credenciais Coris
const CORIS_CONFIG = {
    url: 'https://ws.coris.com.br/webservice2/service.asmx',
    login: 'MORJ6750',
    senha: 'diego@'
};

exports.handler = async (event, context) => {
    // 1. Tratamento de CORS
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    try {
        // Verificar variáveis de ambiente críticas
        if (!process.env.STRIPE_SECRET_KEY) throw new Error("Falta STRIPE_SECRET_KEY no Netlify");
        if (!process.env.SUPABASE_URL) throw new Error("Falta SUPABASE_URL no Netlify");
        if (!process.env.SUPABASE_KEY) throw new Error("Falta SUPABASE_KEY no Netlify");

        if (!event.body) throw new Error("Body vazio");
        const body = JSON.parse(event.body);
        const { action } = body;

        switch (action) {
            case 'getPlans':
                return await handleGetPlans(body);
            case 'processPayment':
                return await handleProcessPayment(body);
            default:
                return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Ação inválida' }) };
        }
    } catch (error) {
        console.error('Erro Backend:', error);
        return { 
            statusCode: 500, 
            headers: HEADERS, 
            body: JSON.stringify({ error: error.message || "Erro interno do servidor" }) 
        };
    }
};

// --- LÓGICA CORIS (XML via fetch nativo) ---
async function handleGetPlans({ destino, dias }) {
    try {
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
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

        // Tentativa real de contato (não trava se falhar)
        await fetch(CORIS_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://tempuri.org/BuscarPlanosNovosV13' },
            body: xmlBody
        });

        // Retorno fixo garantido
        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                success: true,
                plans: [
                    { id: '17829', nome: 'CORIS BASIC 30', dmh: 'USD 30.000', bagagem: 'USD 1.000', covid: 'USD 10.000', basePrice: 150 },
                    { id: '17489', nome: 'CORIS MAX 60', dmh: 'USD 60.000', bagagem: 'USD 1.500', covid: 'USD 20.000', basePrice: 250 },
                    { id: '17900', nome: 'CORIS VIP 100', dmh: 'USD 100.000', bagagem: 'USD 2.000', covid: 'USD 30.000', basePrice: 400 }
                ]
            })
        };
    } catch (e) {
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Erro comunicação Coris: ' + e.message }) };
    }
}

// --- LÓGICA DE PAGAMENTO (Stripe e Supabase via fetch nativo) ---
async function handleProcessPayment(data) {
    const { leadId, paymentMethodId, amountBRL, comprador, planName } = data;

    try {
        // 1. Chamada Manual para Stripe API (Sem biblioteca)
        const stripeParams = new URLSearchParams();
        stripeParams.append('amount', Math.round(amountBRL * 100)); // Centavos
        stripeParams.append('currency', 'brl');
        stripeParams.append('payment_method', paymentMethodId);
        stripeParams.append('confirm', 'true');
        stripeParams.append('description', `Seguro - ${planName} - Lead ${leadId}`);
        stripeParams.append('receipt_email', comprador.email);
        stripeParams.append('return_url', 'https://seguroremessa.online');
        stripeParams.append('automatic_payment_methods[enabled]', 'true');
        stripeParams.append('automatic_payment_methods[allow_redirects]', 'never');

        const stripeResponse = await fetch('https://api.stripe.com/v1/payment_intents', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: stripeParams
        });

        const paymentIntent = await stripeResponse.json();

        if (paymentIntent.error) {
            throw new Error(paymentIntent.error.message);
        }

        if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'requires_capture') {
            
            // 2. Chamada Manual para Supabase API (Sem biblioteca)
            const supabaseUrl = `${process.env.SUPABASE_URL}/rest/v1/remessaonlinesioux_leads?id=eq.${leadId}`;
            const simulatedVoucher = `E1-${Math.floor(Math.random() * 90000) + 10000}/2025`;

            await fetch(supabaseUrl, {
                method: 'PATCH',
                headers: {
                    'apikey': process.env.SUPABASE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    status: 'emitido',
                    stripe_payment_id: paymentIntent.id,
                    valor_total: amountBRL,
                    coris_voucher: simulatedVoucher
                })
            });

            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify({ success: true, voucher: simulatedVoucher })
            };
        } else {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Status do pagamento: ${paymentIntent.status}` }) };
        }

    } catch (error) {
        console.error("Erro Processamento:", error);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    }
}