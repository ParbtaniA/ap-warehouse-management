const https = require('https');
exports.handler = async function(event) {
  const headers = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers,body:''};
  if (event.httpMethod!=='POST') return {statusCode:405,headers,body:'{"error":"Method not allowed"}'};
  let body;
  try { body=JSON.parse(event.body||'{}'); } catch(e) { return {statusCode:400,headers,body:JSON.stringify({error:'Bad JSON'})}; }
  const apiKey=process.env.ANTHROPIC_API_KEY;
  if (body._ping) return {statusCode:200,headers,body:JSON.stringify({status:'ok',keySet:!!apiKey})};
  if (!apiKey) return {statusCode:500,headers,body:JSON.stringify({error:'ANTHROPIC_API_KEY not set'})};
  const rd=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4000,system:body.system||'',messages:body.messages||[]});
  return new Promise(function(resolve){
    const req=https.request({hostname:'api.anthropic.com',port:443,path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(rd),'x-api-key':apiKey,'anthropic-version':'2023-06-01','anthropic-beta':'pdfs-2024-09-25'}},function(res){
      const c=[];res.on('data',function(d){c.push(d);});res.on('end',function(){resolve({statusCode:res.statusCode,headers,body:Buffer.concat(c).toString()});});
    });
    req.on('error',function(e){resolve({statusCode:500,headers,body:JSON.stringify({error:e.message})});});
    req.setTimeout(25000,function(){req.destroy();resolve({statusCode:500,headers,body:JSON.stringify({error:'Timeout'})});});
    req.write(rd);req.end();
  });
};
