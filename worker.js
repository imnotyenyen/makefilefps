import config from './config.js';

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Xử lý CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Nhận request kiểm tra bảo trì
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ maintenance: config.maintenance }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Nhận request kiểm tra mật khẩu
      if (request.method === 'POST') {
        const body = await request.json();
        const isValid = config.passwords.includes(body.password);
        
        return new Response(JSON.stringify({ success: isValid }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: "Lỗi Server" }), { 
        status: 500, headers: corsHeaders 
      });
    }
  }
}
