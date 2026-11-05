import { spawn } from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
child.once('spawn',()=>process.stdout.write(JSON.stringify({childPid:child.pid})+'\n'));
setInterval(()=>{},1000);
