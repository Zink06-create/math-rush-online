const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (_, res) => res.json({ok:true, service:"math-rush-online-v4"}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const players = new Map(); // name -> {name,cups}
const queue = [];
const matches = new Map();

const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
function makeQuestion(){
  const t=rand(1,7), a=rand(3,15), b=rand(2,12);
  let q,ans;
  if(t===1){q=`${a} × ${b} = ?`; ans=a*b;}
  else if(t===2){q=`${a+b} − ${a} = ?`; ans=b;}
  else if(t===3){const x=rand(2,12),k=rand(3,9); q=`若 ${k}x = ${k*x}，那么 x = ?`; ans=x;}
  else if(t===4){const n=rand(20,100),p=rand(1,4)*10; q=`${n} 的 ${p}% 是多少？`; ans=n*p/100;}
  else if(t===5){const n=rand(4,16); q=`正方形边长 ${n} cm，面积是多少？`; ans=n*n;}
  else if(t===6){const n=rand(10,30); q=`一个数加 8 等于 ${n}，这个数是多少？`; ans=n-8;}
  else {const n=rand(2,8); q=`找规律：${n}，${n+3}，${n+6}，${n+9}，下一个数？`; ans=n+12;}
  const opts=new Set([ans]);
  while(opts.size<4){
    const delta=rand(-8,8)||1;
    opts.add(Number.isInteger(ans) ? ans+delta : Math.round((ans+delta)*10)/10);
  }
  return {q,answer:ans,options:[...opts].sort(()=>Math.random()-.5)};
}
function publicPlayer(name){const p=players.get(name)||{name,cups:0}; return {name:p.name,cups:p.cups};}
function leaderboard(){
  return [...players.values()].sort((a,b)=>b.cups-a.cups).slice(0,50);
}
function rankOf(name){
  const arr=[...players.values()].sort((a,b)=>b.cups-a.cups);
  const i=arr.findIndex(p=>p.name===name);
  return i<0 ? null : i+1;
}

app.get("/api/leaderboard",(req,res)=>res.json({players:leaderboard()}));
app.get("/api/player",(req,res)=>{
  const name=String(req.query.name||"玩家").slice(0,18);
  const p=players.get(name)||{name,cups:0};
  res.json({name:p.name,cups:p.cups,rank:rankOf(name)});
});

function startMatch(a,b){
  const id=`${a.id}:${b.id}:${Date.now()}`;
  const pa=players.get(a.data.name)||{name:a.data.name,cups:0};
  const pb=players.get(b.data.name)||{name:b.data.name,cups:0};
  const m={id, players:[a,b], round:0, scores:new Map([[a.id,0],[b.id,0]]), questions:[], answers:new Map(), startedAt:Date.now(), finished:false};
  matches.set(id,m); a.data.matchId=id; b.data.matchId=id;
  a.emit("matched",{opponent:publicPlayer(b.data.name)});
  b.emit("matched",{opponent:publicPlayer(a.data.name)});
  nextRound(m);
}
function nextRound(m){
  if(m.finished)return;
  if(m.round>=10){finishMatch(m);return;}
  m.round++;
  m.answers=new Map();
  const q=makeQuestion(); m.questions[m.round]=q;
  for(const s of m.players){
    if(s.connected)s.emit("question",{round:m.round,q:q.q,options:q.options,timeLimit:15});
  }
  m.deadline=Date.now()+15000;
  clearTimeout(m.timeout); m.timeout=setTimeout(()=>resolveRound(m),15100);
}
function resolveRound(m){
  if(m.finished)return;
  const q=m.questions[m.round];
  for(const s of m.players){
    if(!m.answers.has(s.id))m.answers.set(s.id,{answer:null,correct:false});
  }
  for(const s of m.players){
    const r=m.answers.get(s.id);
    if(r && r.correct){
      const elapsed=Math.min(15,Math.max(0,(Date.now()-m.deadline+15000)/1000));
      const gain=Math.max(40,100+Math.round((15-elapsed)*4));
      m.scores.set(s.id,m.scores.get(s.id)+gain);
    }
  }
  for(const s of m.players){
    const opp=m.players.find(x=>x.id!==s.id);
    if(s.connected)s.emit("score",{you:m.scores.get(s.id),opponent:m.scores.get(opp.id)});
  }
  setTimeout(()=>nextRound(m),650);
}
function finishMatch(m){
  if(m.finished)return; m.finished=true; clearTimeout(m.timeout);
  const [a,b]=m.players;
  const sa=m.scores.get(a.id)||0, sb=m.scores.get(b.id)||0;
  const resultA=sa>sb?"win":sa<sb?"loss":"draw";
  const deltaA=resultA==="win"?22:resultA==="loss"?-12:5;
  const deltaB=-deltaA;
  for(const [s,result,delta,score,oppScore] of [[a,resultA,deltaA,sa,sb],[b,resultA==="win"?"loss":resultA==="loss"?"win":"draw",deltaB,sb,sa]]){
    const p=players.get(s.data.name)||{name:s.data.name,cups:0};
    p.cups=Math.max(0,p.cups+delta); players.set(p.name,p);
    if(s.connected)s.emit("finished",{result, cupDelta:delta, cups:p.cups, youScore:score, opponentScore:oppScore});
    s.data.matchId=null;
  }
  matches.delete(m.id);
}

io.on("connection",socket=>{
  socket.on("joinQueue",({name})=>{
    name=String(name||"玩家").trim().slice(0,18)||"玩家";
    socket.data.name=name;
    if(!players.has(name))players.set(name,{name,cups:0});
    if(queue.find(x=>x.id===socket.id))return;
    queue.push(socket);
    socket.emit("queue",{size:queue.length});
    while(queue.length>=2){
      const a=queue.shift(), b=queue.shift();
      if(!a.connected||!b.connected)continue;
      startMatch(a,b); break;
    }
  });
  socket.on("answer",({answer})=>{
    const id=socket.data.matchId, m=matches.get(id);
    if(!m||m.finished||m.answers.has(socket.id))return;
    const q=m.questions[m.round];
    const correct=answer!==null && Number(answer)===Number(q.answer);
    m.answers.set(socket.id,{answer,correct});
    socket.emit("roundResult",{correct,answer:correct?null:q.answer});
    if(m.answers.size>=2)resolveRound(m);
  });
  socket.on("disconnect",()=>{
    const qi=queue.findIndex(x=>x.id===socket.id); if(qi>=0)queue.splice(qi,1);
    const id=socket.data.matchId, m=matches.get(id);
    if(m&&!m.finished){
      const other=m.players.find(x=>x.id!==socket.id);
      if(other?.connected){
        const p=players.get(other.data.name)||{name:other.data.name,cups:0};
        p.cups+=15; players.set(p.name,p);
        other.emit("finished",{result:"win",cupDelta:15,cups:p.cups,youScore:m.scores.get(other.id)||0,opponentScore:m.scores.get(socket.id)||0});
      }
      m.finished=true; clearTimeout(m.timeout); matches.delete(id);
    }
  });
});

app.get("/",(_,res)=>res.send("Math Rush Online V4 server is running."));
server.listen(PORT,()=>console.log(`Math Rush Online V4 listening on ${PORT}`));
