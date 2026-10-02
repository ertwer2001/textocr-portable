/** Local screenshot reconstruction. All coordinates and font sizes are source pixels.
 * OpenCV Mats are owned by a single synchronous stage and deleted before OCR awaits.
 * Numeric charts require a visible data table; plot heights are never interpreted.
 */
const inside = (point, box) => point[0] >= box[0] && point[1] >= box[1] && point[0] <= box[0] + box[2] && point[1] <= box[1] + box[3];
const center = line => [line.box[0] + line.box[2] / 2, line.box[1] + line.box[3] / 2];
const hex = rgb => rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
const free = (...objects) => objects.forEach(object => object?.delete());
const abort = signal => { if (signal?.aborted) throw new DOMException('已取消辨識', 'AbortError'); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const median = values => { if (!values.length) return 0; const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length/2)]; };
const cellIndex = (positions, value) => { let index = 0; while (index < positions.length && positions[index] <= value) index++; return index-1; };

function canvas(width, height) {
  const result = document.createElement('canvas');
  result.width = Math.max(1, Math.round(width)); result.height = Math.max(1, Math.round(height));
  return result;
}
function crop(source, box, scale = 1) {
  const [x,y,w,h] = box;
  const result = canvas(w*scale, h*scale);
  result.getContext('2d').drawImage(source, x,y,w,h, 0,0,result.width,result.height);
  return result;
}
function bounds(box, width, height, padding = 0) {
  const x = Math.max(0, Math.floor(box[0]-padding)), y = Math.max(0, Math.floor(box[1]-padding));
  const right = Math.min(width, Math.ceil(box[0]+box[2]+padding)), bottom = Math.min(height, Math.ceil(box[1]+box[3]+padding));
  return [x,y,Math.max(0,right-x),Math.max(0,bottom-y)];
}
function clearBoxes(data, width, height, boxes, padding = 0) {
  for (const box of boxes) {
    const [x,y,w,h] = bounds(box,width,height,padding);
    for (let row=y; row<y+h; row++) data.fill(0,row*width+x,row*width+x+w);
  }
}
function region(pixels, width, box, predicate = null) {
  const [x,y,w,h] = box, hist = [new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)], colors = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt(w*h/14000)));
  let count = 0;
  for (let row=y; row<y+h; row+=step) for (let column=x; column<x+w; column+=step) {
    const index = (row*width+column)*4;
    if (predicate && !predicate(index,column,row)) continue;
    const r=pixels[index], g=pixels[index+1], b=pixels[index+2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++; count++;
    const key = (r>>4)*256+(g>>4)*16+(b>>4);
    colors.set(key,(colors.get(key)||0)+1);
  }
  const rgb = hist.map(channel => { let total=0; for(let i=0;i<256;i++){ total+=channel[i]; if(total>=count/2)return i;}return 255; });
  const frequencies = [...colors.values()].sort((a,b)=>b-a);
  return {rgb,count,colors:colors.size,uniform:(frequencies[0]||0)/Math.max(count,1),two:((frequencies[0]||0)+(frequencies[1]||0))/Math.max(count,1)};
}
function positions(counts, minimum) {
  const groups=[];
  for(let i=0;i<counts.length;i++) if(counts[i]>=minimum){
    if(!groups.length || i-groups.at(-1).at(-1)>5)groups.push([i]); else groups.at(-1).push(i);
  }
  return groups.map(group=>Math.round(group.reduce((a,b)=>a+b,0)/group.length));
}
function morph(cv, source, operation, width, height) {
  const kernel = cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(Math.max(1,Math.round(width)),Math.max(1,Math.round(height))));
  const result = new cv.Mat();
  try {cv.morphologyEx(source,result,operation,kernel); return result;} catch(error){result.delete();throw error;} finally {kernel.delete();}
}
function components(cv, mask) {
  const labels=new cv.Mat(), stats=new cv.Mat(), centroids=new cv.Mat();
  try {
    cv.connectedComponentsWithStats(mask,labels,stats,centroids,8,cv.CV_32S);
    const boxes=[];
    for(let i=1;i<stats.rows;i++) boxes.push({index:i,box:Array.from(stats.data32S.slice(i*5,i*5+4)),area:stats.data32S[i*5+4]});
    return boxes;
  } finally {free(labels,stats,centroids);}
}
function contourBoxes(cv, source) {
  const rgba=cv.imread(source), gray=new cv.Mat(), edges=new cv.Mat(), contours=new cv.MatVector(), hierarchy=new cv.Mat();
  const output=[];
  try {
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY); cv.Canny(gray,edges,20,60);
    cv.findContours(edges,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
    for(let index=0;index<contours.size();index++){
      const contour=contours.get(index), polygon=new cv.Mat();
      try {
        const rect=cv.boundingRect(contour), area=cv.contourArea(contour);
        if(area<200 || rect.width<15 || rect.height<12)continue;
        cv.approxPolyDP(contour,polygon,cv.arcLength(contour,true)*.025,true);
        const points=[]; for(let p=0;p<polygon.data32S.length;p+=2)points.push([polygon.data32S[p],polygon.data32S[p+1]]);
        output.push({box:[rect.x,rect.y,rect.width,rect.height],area,points});
      } finally {free(contour,polygon);}
    }
    return output.sort((a,b)=>b.area-a.area);
  } finally {free(rgba,gray,edges,contours,hierarchy);}
}

function tableFromGrid(xs,ys,ink,localWidth,pixels,imageWidth,lines,offset,canRetry) {
  const columns=xs.length-1, rows=ys.length-1, parents=Array.from({length:columns*rows},(_,i)=>i);
  const find = cell => {while(parents[cell]!==cell){parents[cell]=parents[parents[cell]];cell=parents[cell];}return cell;};
  const join = (a,b) => {a=find(a);b=find(b);parents[Math.max(a,b)]=Math.min(a,b);};
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++){
    if(c+1<columns){let present=0,total=0;for(let y=ys[r]+3;y<ys[r+1]-2;y++){total++;if([xs[c+1]-1,xs[c+1],xs[c+1]+1].some(x=>ink[y*localWidth+x]))present++;}if(total && present/total<.3)join(r*columns+c,r*columns+c+1);}
    if(r+1<rows){let present=0,total=0;for(let x=xs[c]+3;x<xs[c+1]-2;x++){total++;if([ys[r+1]-1,ys[r+1],ys[r+1]+1].some(y=>ink[y*localWidth+x]))present++;}if(total && present/total<.3)join(r*columns+c,(r+1)*columns+c);}
  }
  const groups=new Map(), anchors=new Map(), extents=new Map(), merges=[];
  for(let cell=0;cell<parents.length;cell++){const id=find(cell);if(!groups.has(id))groups.set(id,[]);groups.get(id).push([Math.floor(cell/columns),cell%columns]);}
  for(const members of groups.values()){
    const r1=Math.min(...members.map(m=>m[0])),c1=Math.min(...members.map(m=>m[1])),r2=Math.max(...members.map(m=>m[0])),c2=Math.max(...members.map(m=>m[1]));
    if(members.length>1 && members.length===(r2-r1+1)*(c2-c1+1)){
      merges.push([r1,c1,r2,c2]);for(const [r,c]of members)anchors.set(r*columns+c,r1*columns+c1);extents.set(r1*columns+c1,[r2,c2]);
    }
  }
  const globalX=xs.map(x=>x+offset[0]), globalY=ys.map(y=>y+offset[1]);
  const buckets=Array.from({length:rows},()=>Array.from({length:columns},()=>[])), retry=new Set();
  for(const line of lines){
    const [x,y,w,h]=line.box,[cx,cy]=center(line),r=cellIndex(globalY,cy),c=cellIndex(globalX,cx);
    if(r<0 || r>=rows)continue;
    const touched=[];for(let column=0;column<columns;column++)if(Math.min(x+w,globalX[column+1])-Math.max(x,globalX[column])>Math.max(3,w*.15))touched.push(column);
    const targets=new Set(touched.map(column=>anchors.get(r*columns+column)??r*columns+column));
    if(targets.size>1 || (x<globalX[0]-3 && x+w>globalX[0]+3)){targets.forEach(target=>retry.add(target));if(canRetry)continue;}
    if(c>=0 && c<columns){const anchor=anchors.get(r*columns+c)??r*columns+c;buckets[Math.floor(anchor/columns)][anchor%columns].push(line);}
  }
  const values=buckets.map(row=>row.map(cell=>cell.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]).map(line=>line.text).join('\n'))),fills=[];
  for(let r=0;r<rows;r++){
    const fill=[];
    for(let c=0;c<columns;c++){
      const box=[globalX[c]+2,globalY[r]+2,Math.max(1,globalX[c+1]-globalX[c]-3),Math.max(1,globalY[r+1]-globalY[r]-3)];
      let color=region(pixels,imageWidth,box).rgb;if(Math.min(...color)>240)color=[255,255,255];fill.push(color);
      if(!values[r][c] && (anchors.get(r*columns+c)??r*columns+c)===r*columns+c){
        const occupied=region(pixels,imageWidth,box,index=>Math.max(...color.map((v,i)=>Math.abs(pixels[index+i]-v)))>70);
        if(occupied.count>=Math.max(6,Math.min(box[2]*box[3],14000)*.01))retry.add(r*columns+c);
      }
    }fills.push(fill);
  }
  const table={rows:values,widths:xs.slice(1).map((x,i)=>x-xs[i]),heights:ys.slice(1).map((y,i)=>y-ys[i]),fills,merges,box:[globalX[0],globalY[0],globalX.at(-1)-globalX[0],globalY.at(-1)-globalY[0]]};
  const visible=lines.filter(line=>inside(center(line),table.box)).length,effective=rows*columns-merges.reduce((sum,[r1,c1,r2,c2])=>sum+(r2-r1+1)*(c2-c1+1)-1,0);
  if(visible/Math.max(effective,1)<.2)return null;
  return {table,retry,extents,xs:globalX,ys:globalY};
}
function grid(source,lines,cv,offset=[0,0],edgeRules=false){
  const rgba=cv.imread(source),gray=new cv.Mat(),ink=new cv.Mat(),labels=new cv.Mat(),stats=new cv.Mat(),centroids=new cv.Mat();
  let horizontal,vertical,joined,closed;
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);
    if(typeof edgeRules==='number')cv.threshold(gray,ink,edgeRules,255,cv.THRESH_BINARY_INV);else if(edgeRules)cv.Canny(gray,ink,20,60);else cv.threshold(gray,ink,140,255,cv.THRESH_BINARY_INV);
    horizontal=morph(cv,ink,cv.MORPH_OPEN,Math.max(20,source.width/12),1);vertical=morph(cv,ink,cv.MORPH_OPEN,1,Math.max(20,source.height/12));
    joined=new cv.Mat();cv.bitwise_or(horizontal,vertical,joined);closed=morph(cv,joined,cv.MORPH_CLOSE,3,3);
    cv.connectedComponentsWithStats(closed,labels,stats,centroids,8,cv.CV_32S);
    const candidates=[];for(let i=1;i<stats.rows;i++){const row=Array.from(stats.data32S.slice(i*5,i*5+5));if(row[2]>=60&&row[3]>=25)candidates.push({index:i,row});}candidates.sort((a,b)=>b.row[4]-a.row[4]);
    const pixels=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;
    for(const {index,row:[left,top,width,height]}of candidates){
      const xCounts=new Uint32Array(width),yCounts=new Uint32Array(height);
      for(let y=top;y<top+height;y++)for(let x=left;x<left+width;x++){const p=y*source.width+x;if(labels.data32S[p]===index){if(vertical.data[p])xCounts[x-left]++;if(horizontal.data[p])yCounts[y-top]++;}}
      const xs=positions(xCounts,Math.max(20,height*.35)).map(x=>x+left),ys=positions(yCounts,Math.max(30,width*.35)).map(y=>y+top);
      if(xs.length&&xs[0]-left>5&&left>0)xs.unshift(left);if(ys.length&&ys[0]-top>5&&top>0)ys.unshift(top);
      if(xs.length<3||ys.length<3||xs.some((x,i)=>i&&x-xs[i-1]<5)||ys.some((y,i)=>i&&y-ys[i-1]<5))continue;
      const result=tableFromGrid(xs,ys,ink.data,source.width,pixels,source.width,lines.map(line=>({...line,box:[line.box[0]-offset[0],line.box[1]-offset[1],line.box[2],line.box[3]]})),[0,0],false);
      if(result){result.table.box[0]+=offset[0];result.table.box[1]+=offset[1];result.xs=result.xs.map(x=>x+offset[0]);result.ys=result.ys.map(y=>y+offset[1]);return result;}
    }return null;
  }finally{free(rgba,gray,ink,horizontal,vertical,joined,closed,labels,stats,centroids);}
}
function denseGrid(source,lines,cv,contours){
  const cells=contours.filter(({box:[, ,w,h],area,points})=>points.length===4&&h>18&&h<source.height*.2&&w>18&&w<source.width*.5&&area/(w*h)>.84);
  const candidates=[];
  for(const height of [...new Set(cells.map(cell=>Math.round(cell.box[3]/3)*3))]){
    const similar=cells.filter(cell=>Math.abs(cell.box[3]-height)<=3),ys=[];
    for(const y of [...new Set(similar.map(cell=>cell.box[1]))].sort((a,b)=>a-b))if(!ys.length||y-ys.at(-1)>4)ys.push(y);
    const runs=[];for(const y of ys){if(!runs.length||Math.abs(y-runs.at(-1).at(-1)-height)>6)runs.push([y]);else runs.at(-1).push(y);}
    for(const rows of runs){if(rows.length<3)continue;const top=rows[0],bottom=rows.at(-1)+height,members=similar.filter(cell=>cell.box[1]>=top-3&&cell.box[1]<bottom);if(members.length>=rows.length*3)candidates.push({top,bottom,height,members});}
  }
  candidates.sort((a,b)=>b.members.length-a.members.length);
  for(const candidate of candidates.slice(0,4)){
    const headers=cells.filter(cell=>cell.box[3]>candidate.height*1.3&&cell.box[3]<candidate.height*3&&Math.abs(cell.box[1]+cell.box[3]-candidate.top)<5&&cell.box[2]>=median(candidate.members.map(c=>c.box[2]))*.7);
    const extent=[...candidate.members,...headers],left=Math.max(0,Math.min(...extent.map(c=>c.box[0]))-median(candidate.members.map(c=>c.box[2]))*2-5),right=Math.min(source.width,Math.max(...extent.map(c=>c.box[0]+c.box[2]))+5),top=Math.max(0,Math.min(candidate.top,...headers.map(c=>c.box[1]))-3),bottom=Math.min(source.height,candidate.bottom+4);
    const patch=crop(source,[left,top,right-left,bottom-top]);
    let best=null;
    for(const edges of [true,245,false]){const result=grid(patch,lines,cv,[left,top],edges);if(result&&result.table.rows.length>=3&&result.table.rows[0].length>=3&&(!best||result.table.rows.length*result.table.rows[0].length>best.table.rows.length*best.table.rows[0].length))best=result;}
    if(best)return best;
  }return null;
}
function unruled(source,lines,cv,pixels){
  const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);let opened,closed;
  try{
    for(let i=0;i<mask.data.length;i++){const p=i*4,low=Math.min(pixels[p],pixels[p+1],pixels[p+2]),high=Math.max(pixels[p],pixels[p+1],pixels[p+2]);mask.data[i]=(low>210&&low<253&&high-low<30)?255:0;}
    opened=morph(cv,mask,cv.MORPH_OPEN,5,5);closed=morph(cv,opened,cv.MORPH_CLOSE,15,15);
    const bands=components(cv,closed).filter(item=>item.box[2]>source.width*.65&&item.box[3]>25&&item.box[3]<source.height*.32&&item.area/(item.box[2]*item.box[3])>.65).map(item=>item.box);
    if(bands.length<3)return null;
    const step=Math.round(median(bands.map(box=>box[3]))),body=bands.filter(box=>Math.abs(box[3]-step)<8),joined=bands.filter(box=>box[3]>step*1.5&&box[3]<step*3);
    if(body.length<2||(body.length<3&&!joined.length))return null;
    const x=Math.min(...bands.map(b=>b[0])),right=Math.max(...bands.map(b=>b[0]+b[2])),top=Math.min(...bands.map(b=>b[1])),first=Math.min(...body.map(b=>b[1]),...joined.map(b=>b[1]+b[3]-step)),bottom=Math.min(source.height,Math.max(...body.map(b=>b[1]))+step*2);
    const members=lines.filter(line=>inside(center(line),[x,top,right-x,bottom-top])),clusters=[];
    for(const left of members.map(line=>line.box[0]).sort((a,b)=>a-b)){if(!clusters.length||left-median(clusters.at(-1))>18)clusters.push([left]);else clusters.at(-1).push(left);}
    const starts=clusters.filter(cluster=>cluster.length>=3).map(median);if(starts.length<3)return null;
    const padding=starts[0]-x,xs=[x,...starts.slice(1).map(s=>Math.round(s-padding)),right],ys=[top];if(first-top>20)ys.push(first);
    for(let y=first+step;y<=bottom;y+=step)ys.push(y);if(ys.at(-1)<bottom-5)ys.push(bottom);
    const values=Array.from({length:ys.length-1},()=>Array(xs.length-1).fill(''));
    for(const line of [...members].sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0])){const [cx,cy]=center(line),r=cellIndex(ys,cy),c=cellIndex(xs,cx);if(values[r]&&c>=0&&c<values[r].length)values[r][c]+=(values[r][c]?'\n':'')+line.text;}
    const fills=values.map((row,r)=>row.map((_,c)=>region(pixels,source.width,[xs[c]+2,ys[r]+2,xs[c+1]-xs[c]-4,ys[r+1]-ys[r]-4]).rgb));
    return {table:{rows:values,widths:xs.slice(1).map((v,i)=>v-xs[i]),heights:ys.slice(1).map((v,i)=>v-ys[i]),fills,merges:[],box:[x,top,right-x,ys.at(-1)-top]},retry:new Set(),extents:new Map(),xs,ys};
  }finally{free(mask,opened,closed);}
}

async function retryCells(result,recognizeCell,signal,allChart=false){
  if(!result||!recognizeCell)return;
  const {table,xs,ys,retry,extents}=result,columns=table.rows[0].length;
  if(allChart)for(let r=0;r<table.rows.length;r++)for(let c=0;c<columns;c++)if(r||c)retry.add(r*columns+c);
  for(const id of [...retry].sort((a,b)=>a-b)){
    abort(signal);const r=Math.floor(id/columns),c=id%columns,[lastR,lastC]=extents.get(id)||[r,c];
    const box=[xs[c]+2,ys[r]+2,Math.max(1,xs[lastC+1]-xs[c]-3),Math.max(1,ys[lastR+1]-ys[r]-3)];
    const text=await recognizeCell(box,allChart?'chart-cell':'table-cell');if(text||!allChart)table.rows[r][c]=text.trim();
  }
}
function number(text){
  const value=String(text).normalize('NFKC').trim().replace(/[\s,]/g,'');
  if(!/^[-+]?\d+(?:\.\d+)?%?$/.test(value))return null;
  if(!value.endsWith('%'))return Number(value);
  // Shift the decimal as text so 95.9% becomes the literal 0.959, without a
  // division artifact such as 0.9590000000000001 in the embedded workbook.
  const sign=/^[-+]/.test(value)?value[0]:'',raw=value.slice(sign.length,-1),[whole,fraction='']=raw.split('.'),padded=whole.padStart(3,'0');
  return Number(`${sign}${padded.slice(0,-2)}.${padded.slice(-2)}${fraction}`);
}
function chartFromTable(table,source,cv){
  if(!table||table.rows.length<3||table.rows[0].length<5)return null;
  const categories=table.rows[0].slice(1);if(categories.some(value=>!value.trim()||number(value)!==null))return null;
  const palette=['A5A5A5','5B9BD5','ED7D31','A64A08'],series=[];
  for(const row of table.rows.slice(1)){
    const values=row.slice(1).map(number);if(!row[0].trim()||values.some(value=>value===null))return null;
    const percent=row.slice(1).every(value=>value.includes('%'));series.push({name:row[0],values,type:percent?'line':'bar',percent,secondary:!percent,color:palette[series.length%palette.length]});
  }
  const [x,y,w]=table.box;if(!series.some(item=>item.percent)||y<source.height*.3)return null;
  const rgba=cv.imread(source),gray=new cv.Mat(),edges=new cv.Mat();let closed,horizontal;
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);cv.Canny(gray,edges,20,60);closed=morph(cv,edges,cv.MORPH_CLOSE,5,1);horizontal=morph(cv,closed,cv.MORPH_OPEN,Math.max(15,w/50),1);
    const candidates=[];for(let row=Math.floor(source.height*.16);row<y;row++){let count=0;for(let col=x;col<x+w;col++)if(horizontal.data[row*source.width+col])count++;if(count>w*.5)candidates.push(row);}
    if(!candidates.length)return null;
    return {box:[x,candidates[0],w,y-candidates[0]],type:'combo',categories:categories.map(value=>value.replace(/(\d['’]?)0ct/gi,'$1Oct')),series,colors:series.map(item=>item.color)};
  }finally{free(rgba,gray,edges,closed,horizontal);}
}

function vectors(source,pixels,contours,excluded){
  const found=[];
  for(const item of contours){
    const {box:[x,y,w,h],area,points}=item;
    if(Math.min(w,h)<22||area<400||w>source.width*.94||h>source.height*.9||excluded.some(box=>inside([x+w/2,y+h/2],box)))continue;
    if(found.some(other=>Math.abs(x-other.box[0])<7&&Math.abs(y-other.box[1])<7&&Math.abs(w-other.box[2])<14&&Math.abs(h-other.box[3])<14))continue;
    const sample=region(pixels,source.width,[x+2,y+2,w-4,h-4]),ratio=area/(w*h);let kind=null;
    if(points.length===4&&ratio>.38&&ratio<.65)kind='diamond';
    else if(points.length===4&&ratio>.86&&sample.uniform>.65)kind='rect';
    else if(points.length>=6&&points.length<=9&&ratio>.35&&ratio<.8&&sample.two>.88&&w>h*1.1){
      const tip=points.filter(point=>point[0]>=x+w-w*.05);
      if(tip.length===1&&Math.abs(tip[0][1]-y-h/2)<h*.22)kind='rightArrow';
    }
    else if(points.length>=6&&points.length<=12&&ratio>.82&&sample.uniform>.6)kind='roundRect';
    if(!kind)continue;
    const stroke=region(pixels,source.width,[x,y,w,h],(index,col,row)=>(col<x+3||row<y+3||col>x+w-4||row>y+h-4)&&Math.min(pixels[index],pixels[index+1],pixels[index+2])<180).rgb;
    found.push({box:[x,y,w,h],kind,fill:hex(sample.rgb),line:hex(stroke),width:2,points});
  }
  return found.filter(shape=>!(['roundRect','rightArrow'].includes(shape.kind)&&found.some(other=>other.kind==='rect'&&Math.abs(other.box[0]-shape.box[0])<5&&Math.abs(other.box[1]-shape.box[1])<5&&other.box[2]*other.box[3]>shape.box[2]*shape.box[3]*(shape.kind==='rightArrow'?.38:.7))));
}
function pictures(source,pixels,lines,excluded,cv){
  const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);let opened,closed,colorful,colorClosed;
  const found=[];
  try{
    for(let i=0;i<mask.data.length;i++){const p=i*4;mask.data[i]=Math.min(pixels[p],pixels[p+1],pixels[p+2])<225?255:0;}
    clearBoxes(mask.data,source.width,source.height,excluded,2);opened=morph(cv,mask,cv.MORPH_OPEN,3,3);closed=morph(cv,opened,cv.MORPH_CLOSE,7,7);
    for(const {box:[x,y,w,h],area}of components(cv,closed)){
      if(Math.min(w,h)<55||area/(w*h)<.4||w>source.width*.7||h>source.height*.88)continue;
      const sample=region(pixels,source.width,[x,y,w,h]);if(sample.colors<12||sample.uniform>.8)continue;
      const textArea=lines.reduce((sum,line)=>sum+Math.max(0,Math.min(x+w,line.box[0]+line.box[2])-Math.max(x,line.box[0]))*Math.max(0,Math.min(y+h,line.box[1]+line.box[3])-Math.max(y,line.box[1])),0);
      if(textArea/(w*h)>.2)continue;
      if(lines.filter(line=>inside(center(line),[x,y,w,h])).length>=3&&sample.uniform>.25)continue;
      found.push({box:[x,y,w,h]});
    }
    colorful=new cv.Mat(source.height,source.width,cv.CV_8UC1);
    for(let i=0;i<colorful.data.length;i++){const p=i*4;colorful.data[i]=Math.max(pixels[p],pixels[p+1],pixels[p+2])-Math.min(pixels[p],pixels[p+1],pixels[p+2])>80?255:0;}
    colorClosed=morph(cv,colorful,cv.MORPH_CLOSE,7,7);
    for(const {box:[x,y,w,h]}of components(cv,colorClosed)){
      if(w<40||h<12||y+h>source.height*.22||!(x+w<source.width*.25||x>source.width*.8))continue;
      const hues=[];for(let row=y;row<y+h;row+=2)for(let col=x;col<x+w;col+=2){const p=(row*source.width+col)*4,[hue,sat]=hsv(pixels[p],pixels[p+1],pixels[p+2]);if(sat>100)hues.push(hue);}
      const avg=hues.reduce((a,b)=>a+b,0)/Math.max(hues.length,1),deviation=Math.sqrt(hues.reduce((sum,v)=>sum+(v-avg)**2,0)/Math.max(hues.length,1));
      if(hues.length>=30&&deviation>=15&&!found.some(picture=>inside([x+w/2,y+h/2],picture.box)))found.push({box:[x,y,w,h]});
    }
    return found.map(item=>({...item,canvas:crop(source,item.box)}));
  }finally{free(mask,opened,closed,colorful,colorClosed);}
}
function hsv(r,g,b){const high=Math.max(r,g,b),low=Math.min(r,g,b),delta=high-low;let hue=0;if(delta){if(high===r)hue=60*((g-b)/delta%6);else if(high===g)hue=60*((b-r)/delta+2);else hue=60*((r-g)/delta+4);}if(hue<0)hue+=360;return [hue/2,high?delta/high*255:0,high];}
function connectors(source,pixels,excluded,cv){
  const bins=new Int8Array(source.width*source.height);bins.fill(-1);const counts=new Map(),output=[];
  for(let i=0;i<bins.length;i++){const p=i*4,[h,s,v]=hsv(pixels[p],pixels[p+1],pixels[p+2]);let bin=-1;if(s>110&&v>100)bin=Math.floor(h/10);else if(s<60&&v<185)bin=18;if(bin>=0){bins[i]=bin;counts.set(bin,(counts.get(bin)||0)+1);}}
  for(const [bin,count]of counts){
    if(count<15)continue;
    const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);
    try{
      for(let i=0;i<bins.length;i++)mask.data[i]=bins[i]===bin?255:0;clearBoxes(mask.data,source.width,source.height,excluded,1);
      for(const {box:[x,y,w,h],area}of components(cv,mask)){
        if(Math.max(w,h)<15||(area/(w*h)>=.22&&Math.min(w,h)>4)||Math.max(w,h)<=Math.min(w,h)*1.5)continue;
        const rgb=region(pixels,source.width,[x,y,w,h],(_,col,row)=>mask.data[row*source.width+col]).rgb;if(bin!==18&&Math.max(...rgb)<180)continue;
        if(w>h){let position=0,maximum=0;for(let row=y;row<y+h;row++){let n=0;for(let col=x;col<x+w;col++)if(mask.data[row*source.width+col])n++;if(n>maximum){maximum=n;position=row;}}output.push({x1:x,y1:position,x2:x+w,y2:position,color:hex(rgb),width:1,arrow:h>4&&w<source.width*.15});}
        else output.push({x1:x+w/2,y1:y,x2:x+w/2,y2:y+h,color:hex(rgb),width:1,arrow:w>4});
      }
    }finally{mask.delete();}
  }return output;
}

function typography(lines,pixels,width,height){
  for(const line of lines){
    line.box=bounds(line.box,width,height);const [x,y,w,h]=line.box;if(!w||!h){line.preserveImage=true;continue;}
    if(line.polygon?.length>=2){const [a,b]=line.polygon;if(Math.abs(Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI)>10){line.preserveImage=true;continue;}}
    const bg=region(pixels,width,[x,y,w,h]).rgb,contrasts=[];
    for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const p=(row*width+col)*4,v=Math.max(...bg.map((channel,i)=>Math.abs(pixels[p+i]-channel)));if(v>45)contrasts.push(v);}
    contrasts.sort((a,b)=>a-b);const strong=contrasts[Math.floor(contrasts.length*.8)]||45;
    let color=region(pixels,width,[x,y,w,h],p=>Math.max(...bg.map((channel,i)=>Math.abs(pixels[p+i]-channel)))>=strong).rgb;
    if(Math.max(...color)-Math.min(...color)<25)color=color.map(()=>color.reduce((a,b)=>a+b)/3>200?255:0);
    line.color=hex(color);line.fontSize=line.fontSize||Math.max(4,Math.min(160,h*1.1,w/Math.max(1,[...line.text].reduce((sum,c)=>sum+(c.codePointAt(0)>255?1:.55),0))));line.bold=Boolean(line.bold);
  }
}
function eraseText(source,pixels,lines,pictureBoxes,cv){
  const background=canvas(source.width,source.height),context=background.getContext('2d');context.drawImage(source,0,0);
  const rgba=cv.imread(source),gray=new cv.Mat(),ink=new cv.Mat(),erase=new cv.Mat(source.height,source.width,cv.CV_8UC1);let horizontal,vertical,solid,rules,dilated;
  const replacement=new Uint8ClampedArray(pixels),backgrounds=[];
  try{
    erase.data.fill(0);cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);cv.threshold(gray,ink,185,255,cv.THRESH_BINARY_INV);
    horizontal=morph(cv,ink,cv.MORPH_OPEN,Math.max(80,source.width/20),1);vertical=morph(cv,ink,cv.MORPH_OPEN,1,Math.max(80,source.height/20));solid=morph(cv,ink,cv.MORPH_OPEN,9,9);
    for(let i=0;i<solid.data.length;i++)if(solid.data[i]){horizontal.data[i]=0;vertical.data[i]=0;}
    rules=new cv.Mat();cv.bitwise_or(horizontal,vertical,rules);dilated=morph(cv,rules,cv.MORPH_DILATE,3,3);rules.delete();rules=dilated;dilated=null;
    for(const line of lines){
      if(line.preserveImage||pictureBoxes.some(box=>inside(center(line),box)))continue;
      const [x,y,w,h]=bounds(line.box,source.width,source.height),bg=region(pixels,source.width,[x,y,w,h]).rgb;
      backgrounds.push({box:[x,y,w,h],bg});
      for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const i=row*source.width+col,p=i*4;if(!rules.data[i]&&Math.max(...bg.map((v,c)=>Math.abs(pixels[p+c]-v)))>45)erase.data[i]=255;}
    }
    dilated=morph(cv,erase,cv.MORPH_DILATE,3,3);clearBoxes(dilated.data,source.width,source.height,pictureBoxes,1);for(let i=0;i<rules.data.length;i++)if(rules.data[i])dilated.data[i]=0;
    if(typeof cv.inpaint==='function'&&cv.INPAINT_TELEA!==undefined){const rgb=new cv.Mat(),restored=new cv.Mat();try{cv.cvtColor(rgba,rgb,cv.COLOR_RGBA2RGB);cv.inpaint(rgb,dilated,restored,3,cv.INPAINT_TELEA);cv.imshow(background,restored);}finally{free(rgb,restored);}}
    else{
      for(const {box,bg}of backgrounds){const [x,y,w,h]=bounds(box,source.width,source.height,1);for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const i=row*source.width+col;if(dilated.data[i]){const p=i*4;replacement[p]=bg[0];replacement[p+1]=bg[1];replacement[p+2]=bg[2];replacement[p+3]=255;}}}
      context.putImageData(new ImageData(replacement,source.width,source.height),0,0);
    }
    for(const box of pictureBoxes){const [x,y,w,h]=box;context.drawImage(source,x,y,w,h,x,y,w,h);}
    return background;
  }finally{free(rgba,gray,ink,erase,horizontal,vertical,solid,rules,dilated);}
}

export async function analyzePage(page,{cv,recognize,signal}={}){
  abort(signal);if(!cv?.Mat)throw new Error('版面分析元件尚未準備好，請等待初始化完成。');
  if(!page?.canvas?.width||!page.canvas.height)throw new Error('找不到可辨識的原始圖片。');
  const source=page.canvas;page.width=source.width;page.height=source.height;
  page.lines=(page.lines||[]).filter(line=>line?.text&&line.box?.length===4).map((line,index)=>({...line,text:String(line.text),index,box:[...line.box]}));
  const pixels=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;
  typography(page.lines,pixels,source.width,source.height);await tick();abort(signal);
  const cache=new Map();
  const recognizeCell=recognize?async(box,reason)=>{
    const key=box.map(Math.round).join(',');if(!cache.has(key))cache.set(key,(async()=>{
      abort(signal);const patch=crop(source,box,3);
      try{const result=await recognize(patch,{signal,box:[...box],scale:3,reason});abort(signal);if(typeof result==='string')return result;if(Array.isArray(result))return result.map(line=>typeof line==='string'?line:line.text||'').join(' ');return result?.text||result?.lines?.map(line=>line.text).join(' ')||'';}
      finally{patch.width=1;patch.height=1;}
    })());return cache.get(key);
  }:null;
  const contours=contourBoxes(cv,source);abort(signal);
  const percent=page.lines.some(line=>line.text.includes('%'));
  let detected=percent?denseGrid(source,page.lines,cv,contours):null;
  const edgeRuled=grid(source,page.lines,cv,[0,0],true),inkRuled=grid(source,page.lines,cv);
  let ruled=edgeRuled||inkRuled;
  if(!ruled)ruled=grid(source,page.lines,cv,[0,0],245);
  if(edgeRuled&&inkRuled&&edgeRuled.table.rows.length===inkRuled.table.rows.length&&inkRuled.table.rows[0].length>edgeRuled.table.rows[0].length&&edgeRuled.table.box.every((value,i)=>Math.abs(value-inkRuled.table.box[i])<8))ruled=inkRuled;
  // A dense-cell crop can miss its header/legend column. Prefer a nearby enclosing
  // ruled table, while rejecting a plot grid extending far above the data rows.
  if(!detected||(ruled&&inside(center({box:detected.table.box}),ruled.table.box)&&ruled.table.box[3]<=detected.table.box[3]*2.2&&ruled.table.box[2]<=detected.table.box[2]*2.2&&ruled.table.rows.length>=detected.table.rows.length&&ruled.table.rows[0].length>=detected.table.rows[0].length))detected=ruled;
  if(!detected)detected=denseGrid(source,page.lines,cv,contours);
  if(!detected||detected.table.rows.length<3){const aligned=unruled(source,page.lines,cv,pixels);if(aligned&&(!detected||aligned.table.rows.length>detected.table.rows.length))detected=aligned;}
  await retryCells(detected,recognizeCell,signal);
  if(detected&&detected.table.rows.flat().filter(text=>text.includes('%')).length>=5)await retryCells(detected,recognizeCell,signal,true);
  abort(signal);const table=detected?.table||null,chart=chartFromTable(table,source,cv),tables=table?[{box:table.box,table}]:[],charts=chart?[chart]:[],issues=[];
  const excluded=[...tables,...charts].map(item=>item.box);
  let retainedChart=null;
  if(table&&!chart&&table.rows.flat().filter(text=>text.includes('%')).length>5){issues.push('圖表資料尚未可靠辨識，原圖保留，請核對數字。');const [x,y,w]=table.box;if(y>source.height*.3){retainedChart=[x,Math.floor(source.height*.16),w,y-Math.floor(source.height*.16)];excluded.push(retainedChart);}}
  await tick();abort(signal);
  let shapes=vectors(source,pixels,contours,excluded);
  const photos=pictures(source,pixels,page.lines,[...excluded,...shapes.map(shape=>shape.box)],cv);if(retainedChart)photos.push({box:retainedChart,canvas:crop(source,retainedChart)});
  for(const shape of shapes){
    const members=page.lines.filter(line=>!line.preserveImage&&line.box[2]<=shape.box[2]*1.4&&line.box[3]<=shape.box[3]*1.4&&inside(center(line),shape.box)&&!photos.some(photo=>inside(center(line),photo.box)));
    shape.text=members.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]).map(line=>line.text).join('\n');shape.lineIndices=members.map(line=>line.index);
    shape.textCoverage=members.reduce((sum,line)=>sum+Math.max(0,Math.min(shape.box[0]+shape.box[2],line.box[0]+line.box[2])-Math.max(shape.box[0],line.box[0]))*Math.max(0,Math.min(shape.box[1]+shape.box[3],line.box[1]+line.box[3])-Math.max(shape.box[1],line.box[1])),0)/(shape.box[2]*shape.box[3]);
    if(members.length){shape.fontSize=members.reduce((sum,line)=>sum+line.fontSize,0)/members.length;shape.textColor=members[0].color;}
  }
  shapes=shapes.filter(shape=>(shape.text&&shape.textCoverage<.65)||shape.kind==='rightArrow'||shape.box[2]>source.width*.65);
  const lines=connectors(source,pixels,[...excluded,...shapes.map(shape=>shape.box),...photos.map(photo=>photo.box),...page.lines.map(line=>line.box)],cv);
  for(const line of page.lines)if(photos.some(photo=>inside(center(line),photo.box)))line.preserveImage=true;
  await tick();abort(signal);
  const backgroundCanvas=eraseText(source,pixels,page.lines,photos.map(photo=>photo.box),cv);
  return {backgroundCanvas,table,tables:table?[table]:[],analyses:{tables,charts,shapes,pictures:photos,lines,issues}};
}
