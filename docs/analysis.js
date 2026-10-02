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
function contrastCrop(source){
  const result=crop(source,[0,0,source.width,source.height]),context=result.getContext('2d'),data=context.getImageData(0,0,result.width,result.height),hist=new Uint32Array(256),gray=[];
  for(let p=0;p<data.data.length;p+=4){const value=Math.round(data.data[p]*.299+data.data[p+1]*.587+data.data[p+2]*.114);gray.push(value);hist[value]++;}
  let low=0,high=255,count=0;for(let i=0;i<256;i++){count+=hist[i];if(count>gray.length*.005){low=i;break;}}count=0;for(let i=255;i>=0;i--){count+=hist[i];if(count>gray.length*.005){high=i;break;}}
  if(high-low<20){result.width=1;result.height=1;return null;}
  for(let i=0;i<gray.length;i++){const value=Math.max(0,Math.min(255,Math.round((gray[i]-low)*255/(high-low)))),p=i*4;data.data[p]=data.data[p+1]=data.data[p+2]=value;}
  context.putImageData(data,0,0);return result;
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
  const rgb = hist.map(channel => { if(!count)return 255;let total=0; for(let i=0;i<256;i++){ total+=channel[i]; if(total>=count/2)return i;}return 255; });
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
function contourBoxes(cv, source, inkContours=true) {
  const rgba=cv.imread(source), gray=new cv.Mat(), edges=new cv.Mat(), contours=new cv.MatVector(), hierarchy=new cv.Mat();
  const output=[];
  try {
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);
    for(const solidInk of (inkContours?[false,true]:[false])){
      if(solidInk){cv.threshold(gray,edges,180,255,cv.THRESH_BINARY_INV);for(let i=0;i<edges.data.length;i++)edges.data[i]=Math.min(rgba.data[i*4],rgba.data[i*4+1],rgba.data[i*4+2])<180?255:0;}else cv.Canny(gray,edges,20,60);
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
    }
    return output.sort((a,b)=>b.area-a.area);
  } finally {free(rgba,gray,edges,contours,hierarchy);}
}

function tableFromGrid(xs,ys,ink,localWidth,pixels,imageWidth,lines,offset,canRetry) {
  const columns=xs.length-1, rows=ys.length-1, parents=Array.from({length:columns*rows},(_,i)=>i);
  const find = cell => {while(parents[cell]!==cell){parents[cell]=parents[parents[cell]];cell=parents[cell];}return cell;};
  const join = (a,b) => {a=find(a);b=find(b);parents[Math.max(a,b)]=Math.min(a,b);};
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++){
    if(c+1<columns){let present=0,total=0;for(let y=ys[r]+3;y<ys[r+1]-2;y++){total++;if([-2,-1,0,1,2].some(delta=>ink[y*localWidth+xs[c+1]+delta]))present++;}if(total && present/total<.3)join(r*columns+c,r*columns+c+1);}
    if(r+1<rows){let present=0,total=0;for(let x=xs[c]+3;x<xs[c+1]-2;x++){total++;if([-2,-1,0,1,2].some(delta=>ink[(ys[r+1]+delta)*localWidth+x]))present++;}if(total && present/total<.3)join(r*columns+c,(r+1)*columns+c);}
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
      let color=region(pixels,imageWidth,box).rgb;if(Math.min(...color)>252)color=[255,255,255];fill.push(color);
      if(!values[r][c] && (anchors.get(r*columns+c)??r*columns+c)===r*columns+c){
        const occupied=region(pixels,imageWidth,box,(index,x,y)=>x>box[0]+2&&y>box[1]+2&&x<box[0]+box[2]-3&&y<box[1]+box[3]-3&&Math.max(...color.map((v,i)=>Math.abs(pixels[index+i]-v)))>70);
        if(occupied.count>=Math.max(6,Math.min(box[2]*box[3],14000)*.01))retry.add(r*columns+c);
      }
    }fills.push(fill);
  }
  const cellStyles=buckets.map((row,r)=>row.map((members,c)=>{
    if(!members.length)return {};
    const fontSize=median(members.map(line=>line.fontSize||line.box[3])),left=Math.min(...members.map(line=>(line.inkBox||line.box)[0])),right=Math.max(...members.map(line=>{const box=line.inkBox||line.box;return box[0]+box[2];})),width=globalX[c+1]-globalX[c];
    return {fontSize,fontFamily:members[0].fontFamily,color:members[0].color||'000000',bold:members.some(line=>line.bold),align:left-globalX[c]>width*.2&&Math.abs((left+right)/2-(globalX[c]+globalX[c+1])/2)<width*.12?'ctr':'l'};
  }));
  const borderColors=new Map();
  const ruleColor=(x,y,vertical)=>{
    if(x<4||y<4||x>=imageWidth-4||y*imageWidth*4>=pixels.length-imageWidth*16)return;
    let best=null;
    for(let delta=-2;delta<=2;delta++){
      const p=((y+(vertical?0:delta))*imageWidth+x+(vertical?delta:0))*4,rgb=Array.from(pixels.slice(p,p+3)),a=((y+(vertical?0:-4))*imageWidth+x+(vertical?-4:0))*4,b=((y+(vertical?0:4))*imageWidth+x+(vertical?4:0))*4;
      if(Math.min(...rgb)>250)continue;
      const contrast=Math.min(Math.max(...rgb.map((v,i)=>Math.abs(v-pixels[a+i]))),Math.max(...rgb.map((v,i)=>Math.abs(v-pixels[b+i]))));
      if(contrast>12&&(!best||contrast>best.contrast))best={rgb,contrast};
    }
    if(best){const key=best.rgb.map(value=>value>>3).join(','),entry=borderColors.get(key)||{count:0,rgb:best.rgb};entry.count++;borderColors.set(key,entry);}
  };
  for(const y of globalY)for(let x=globalX[0]+4;x<globalX.at(-1)-3;x+=3)ruleColor(x,y,false);
  for(const x of globalX)for(let y=globalY[0]+4;y<globalY.at(-1)-3;y+=3)ruleColor(x,y,true);
  const borderColor=hex([...borderColors.values()].sort((a,b)=>b.count-a.count)[0]?.rgb||[0,0,0]);
  const table={rows:values,widths:xs.slice(1).map((x,i)=>x-xs[i]),heights:ys.slice(1).map((y,i)=>y-ys[i]),fills,cellStyles,borderColor,borderWidth:1,merges,box:[globalX[0],globalY[0],globalX.at(-1)-globalX[0],globalY.at(-1)-globalY[0]]};
  const visible=lines.filter(line=>inside(center(line),table.box)).length,effective=rows*columns-merges.reduce((sum,[r1,c1,r2,c2])=>sum+(r2-r1+1)*(c2-c1+1)-1,0);
  if(visible/Math.max(effective,1)<.2)return null;
  return {table,retry,extents,xs:globalX,ys:globalY};
}
function grid(source,lines,cv,offset=[0,0],edgeRules=false){
  const rgba=cv.imread(source),gray=new cv.Mat(),ink=new cv.Mat(),labels=new cv.Mat(),stats=new cv.Mat(),centroids=new cv.Mat();
  let horizontal,vertical,joined,closed,solid;
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);
    if(edgeRules==='color'){
      cv.threshold(gray,ink,140,255,cv.THRESH_BINARY_INV);for(let i=0;i<ink.data.length;i++){const p=i*4,low=Math.min(rgba.data[p],rgba.data[p+1],rgba.data[p+2]),high=Math.max(rgba.data[p],rgba.data[p+1],rgba.data[p+2]);ink.data[i]=high-low>55&&high>130?255:0;}
      solid=morph(cv,ink,cv.MORPH_OPEN,5,5);cv.subtract(ink,solid,ink);
    }else if(typeof edgeRules==='number')cv.threshold(gray,ink,edgeRules,255,cv.THRESH_BINARY_INV);else if(edgeRules)cv.Canny(gray,ink,20,60);else cv.threshold(gray,ink,140,255,cv.THRESH_BINARY_INV);
    horizontal=morph(cv,ink,cv.MORPH_OPEN,Math.max(20,source.width/12),1);vertical=morph(cv,ink,cv.MORPH_OPEN,1,Math.max(20,source.height/12));
    joined=new cv.Mat();cv.bitwise_or(horizontal,vertical,joined);closed=morph(cv,joined,cv.MORPH_CLOSE,5,5);
    cv.connectedComponentsWithStats(closed,labels,stats,centroids,8,cv.CV_32S);
    const candidates=[];for(let i=1;i<stats.rows;i++){const row=Array.from(stats.data32S.slice(i*5,i*5+5));if(row[2]>=60&&row[3]>=25)candidates.push({index:i,row});}candidates.sort((a,b)=>b.row[4]-a.row[4]);
    const pixels=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;
    for(const {index,row:[left,top,width,height]}of candidates){
      const xCounts=new Uint32Array(width),yCounts=new Uint32Array(height);
      for(let y=top;y<top+height;y++)for(let x=left;x<left+width;x++){const p=y*source.width+x;if(labels.data32S[p]===index){if(vertical.data[p])xCounts[x-left]++;if(horizontal.data[p])yCounts[y-top]++;}}
      const xs=positions(xCounts,Math.max(20,height*.35)).map(x=>x+left),ys=positions(yCounts,Math.max(30,width*.35)).map(y=>y+top);
      if(xs.length&&xs[0]-left>5&&left>0)xs.unshift(left);if(ys.length&&ys[0]-top>5&&top>0)ys.unshift(top);
      // A full-width title band above a real grid belongs to the slide heading,
      // not an extra row. At least one interior column rule must enter that row.
      while(ys.length>3&&xs.length>2){let present=0,total=0;for(const x of xs.slice(1,-1))for(let y=ys[0]+3;y<ys[1]-2;y++){total++;if([x-2,x-1,x,x+1,x+2].some(column=>vertical.data[y*source.width+column]))present++;}if(!total||present/total>=.15)break;ys.shift();}
      if(xs.length<3||ys.length<3||xs.some((x,i)=>i&&x-xs[i-1]<5)||ys.some((y,i)=>i&&y-ys[i-1]<5))continue;
      const result=tableFromGrid(xs,ys,ink.data,source.width,pixels,source.width,lines.map(line=>({...line,box:[line.box[0]-offset[0],line.box[1]-offset[1],line.box[2],line.box[3]],...(line.inkBox?{inkBox:[line.inkBox[0]-offset[0],line.inkBox[1]-offset[1],line.inkBox[2],line.inkBox[3]]}:{})})),[0,0],false);
      if(result){result.table.box[0]+=offset[0];result.table.box[1]+=offset[1];result.xs=result.xs.map(x=>x+offset[0]);result.ys=result.ys.map(y=>y+offset[1]);return result;}
    }return null;
  }finally{free(rgba,gray,ink,horizontal,vertical,joined,closed,solid,labels,stats,centroids);}
}
function denseGrids(source,lines,cv,contours){
  const cells=contours.filter(({box:[, ,w,h],area,points})=>points.length===4&&h>8&&h<source.height*.2&&w>18&&w<source.width*.5&&area/(w*h)>.84);
  const candidates=[];
  for(const height of [...new Set(cells.map(cell=>Math.round(cell.box[3]/3)*3))]){
    const similar=cells.filter(cell=>Math.abs(cell.box[3]-height)<=3),ys=[];
    for(const y of [...new Set(similar.map(cell=>cell.box[1]))].sort((a,b)=>a-b))if(!ys.length||y-ys.at(-1)>4)ys.push(y);
    const runs=[];for(const y of ys){if(!runs.length||Math.abs(y-runs.at(-1).at(-1)-height)>6)runs.push([y]);else runs.at(-1).push(y);}
    for(const rows of runs){if(rows.length<3)continue;const top=rows[0],bottom=rows.at(-1)+height,members=similar.filter(cell=>cell.box[1]>=top-3&&cell.box[1]<bottom);if(members.length>=rows.length*3)candidates.push({top,bottom,height,members});}
  }
  candidates.sort((a,b)=>b.members.length-a.members.length);
  const results=[];
  for(const candidate of candidates.slice(0,8)){
    const headers=cells.filter(cell=>cell.box[3]>candidate.height*1.3&&cell.box[3]<candidate.height*3&&Math.abs(cell.box[1]+cell.box[3]-candidate.top)<5&&cell.box[2]>=median(candidate.members.map(c=>c.box[2]))*.7);
    const extent=[...candidate.members,...headers],first=Math.min(...extent.map(c=>c.box[0])),cellWidth=median(candidate.members.map(c=>c.box[2])),legend=extent.some(cell=>Math.abs(cell.box[0]-first)<4&&cell.box[2]>cellWidth*1.25),right=Math.min(source.width,Math.max(...extent.map(c=>c.box[0]+c.box[2]))+5),left=Math.max(0,first-(legend?3:cellWidth*2+5)),headerLines=lines.filter(line=>center(line)[1]>=candidate.top-candidate.height*1.4&&center(line)[1]<candidate.top&&line.box[0]>=first&&line.box[0]<right&&number(line.text)===null),headerTop=!headers.length&&headerLines.length>=3?candidate.top-candidate.height:candidate.top,top=Math.max(0,Math.min(headerTop,...headers.map(c=>c.box[1]))-3),bottom=Math.min(source.height,candidate.bottom+4);
    const patch=crop(source,[left,top,right-left,bottom-top]);
    let best=null;
    for(const edges of [true,245,false,'color']){const result=grid(patch,lines,cv,[left,top],edges);if(result&&result.table.rows.length>=3&&result.table.rows[0].length>=3&&(!best||result.table.rows.length*result.table.rows[0].length>best.table.rows.length*best.table.rows[0].length))best=result;}
    patch.width=1;patch.height=1;
    if(best&&!results.some(result=>result.table.box.every((value,i)=>Math.abs(value-best.table.box[i])<8)))results.push(best);
  }return results.sort((a,b)=>a.table.box[1]-b.table.box[1]||a.table.box[0]-b.table.box[0]);
}
function denseGrid(source,lines,cv,contours){return denseGrids(source,lines,cv,contours)[0]||null;}
// A slide's independent cards can share the same y coordinates. Detect each
// enclosing rectangle before projecting rules; never project all cards together.
function localGrids(source,lines,cv,contours){
  const regions=[];
  const rgba=cv.imread(source),gray=new cv.Mat(),edges=new cv.Mat();let horizontal,vertical,uprightClosed;
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);cv.Canny(gray,edges,20,60);horizontal=morph(cv,edges,cv.MORPH_OPEN,Math.max(35,source.width/20),1);
    vertical=morph(cv,edges,cv.MORPH_OPEN,1,Math.max(12,source.height/60));uprightClosed=morph(cv,vertical,cv.MORPH_CLOSE,3,7);const uprights=components(cv,uprightClosed).map(item=>item.box);
    const groups=[];
    for(const {box:[x,y,w,h]}of components(cv,horizontal).sort((a,b)=>a.box[1]-b.box[1])){
      if(w<source.width*.12||h>8)continue;
      let group=groups.find(group=>Math.abs(median(group.map(box=>box[0]))-x)<8&&Math.abs(median(group.map(box=>box[0]+box[2]))-x-w)<8);
      if(!group){group=[];groups.push(group);}group.push([x,y,w,h]);
    }
    for(const group of groups){
      const ys=positions(Array.from({length:source.height},(_,y)=>group.some(box=>y>=box[1]&&y<box[1]+box[3])?1:0),1);
      const runs=[];for(const y of ys){if(!runs.length||y-runs.at(-1).at(-1)>source.height*.25)runs.push([y]);else runs.at(-1).push(y);}
      for(const run of runs)if(run.length>=3){
        const x=median(group.map(box=>box[0])),right=median(group.map(box=>box[0]+box[2])),top=run[0],bottom=run.at(-1),columns=uprights.filter(([vx,vy,vw,vh])=>vx>=x-5&&vx+vw<=right+5&&Math.min(bottom,vy+vh)-Math.max(top,vy)>(bottom-top)*.45);
        regions.push([x,Math.min(top,...columns.map(box=>box[1])),right-x,Math.max(bottom,...columns.map(box=>box[1]+box[3]))-Math.min(top,...columns.map(box=>box[1]))+1]);
      }
    }
  }finally{free(rgba,gray,edges,horizontal,vertical,uprightClosed);}
  for(const {box,area,points}of contours){
    const [x,y,w,h]=box;
    if(points.length!==4||area/(w*h)<.85||w<80||h<45||w*h<source.width*source.height*.015)continue;
    if(w>source.width*.98&&h>source.height*.95)continue;
    if(regions.some(other=>box.every((value,i)=>Math.abs(value-other[i])<5)))continue;
    regions.push(box);if(regions.length>=18)break;
  }
  const results=[];
  for(const box of regions){
    const clipped=bounds(box,source.width,source.height,3),patch=crop(source,clipped),offset=clipped.slice(0,2);
    let best=null;
    for(const mode of [true,false,245,'color']){
      const candidate=grid(patch,lines,cv,offset,mode);if(!candidate)continue;
      if(!best||candidate.table.rows.length*candidate.table.rows[0].length>best.table.rows.length*best.table.rows[0].length)best=candidate;
    }
    patch.width=1;patch.height=1;
    if(best&&lines.filter(line=>inside(center(line),best.table.box)).length>=4&&!results.some(item=>item.table.box.every((value,i)=>Math.abs(value-best.table.box[i])<8)))results.push(best);
  }
  // Keep the enclosing table rather than another crop of its individual cells.
  return results.filter(result=>!results.some(other=>other!==result&&inside(center({box:result.table.box}),other.table.box)&&other.table.box[2]*other.table.box[3]>result.table.box[2]*result.table.box[3]*1.15)).sort((a,b)=>a.table.box[1]-b.table.box[1]||a.table.box[0]-b.table.box[0]);
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
    const text=(await recognizeCell(box,allChart?'chart-cell':'table-cell')).trim(),previous=table.rows[r][c];
    if(allChart&&text&&text!==previous&&((number(previous)!==null&&number(text)!==null&&number(previous)!==number(text))||/^#(?:DIV\/0!|N\/A|VALUE!|REF!|NUM!|NAME\?|NULL!)$/i.test(previous))){result.disagreements||=[];result.disagreements.push({row:r,column:c});continue;}
    if(text)table.rows[r][c]=text;
  }
}
function recoveredCellStyles(result,pixels,width,height){
  const {table,xs,ys,extents}=result,columns=table.rows[0].length;table.cellStyles||=table.rows.map(row=>row.map(()=>({})));
  for(let r=0;r<table.rows.length;r++)for(let c=0;c<columns;c++){
    const text=table.rows[r][c];if(!text||table.cellStyles[r][c].fontSize||text.includes('\n'))continue;
    const [lastR,lastC]=extents.get(r*columns+c)||[r,c],line={text,box:[xs[c]+3,ys[r]+3,Math.max(1,xs[lastC+1]-xs[c]-6),Math.max(1,ys[lastR+1]-ys[r]-6)]};
    typography([line],pixels,width,height);const box=line.inkBox||line.box,cellWidth=xs[lastC+1]-xs[c];
    table.cellStyles[r][c]={fontSize:line.fontSize,fontFamily:line.fontFamily,color:line.color,bold:line.bold,align:Math.abs(box[0]+box[2]/2-(xs[c]+xs[lastC+1])/2)<cellWidth*.15?'ctr':'l'};
  }
}
function number(text){
  const rawText=String(text).normalize('NFKC').trim().replace(/\s/g,'');if(rawText.includes(',')&&!/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(rawText))return null;
  const value=rawText.replace(/,/g,'');
  if(!/^[-+]?\d+(?:\.\d+)?%?$/.test(value))return null;
  if(!value.endsWith('%'))return Number(value);
  // Shift the decimal as text so 95.9% becomes the literal 0.959, without a
  // division artifact such as 0.9590000000000001 in the embedded workbook.
  const sign=/^[-+]/.test(value)?value[0]:'',raw=value.slice(sign.length,-1),[whole,fraction='']=raw.split('.'),padded=whole.padStart(3,'0');
  return Number(`${sign}${padded.slice(0,-2)}.${padded.slice(-2)}${fraction}`);
}
const chartName = text => String(text||'').normalize('NFKC').replace(/[\s\-_/：:()（）]/g,'').toLowerCase();
function chartLabelMatch(text,name){const label=chartName(text),key=chartName(name);if(label.includes(key))return true;if(key.length<4)return false;for(let start=0;start<=label.length-key.length;start++){let different=0;for(let i=0;i<key.length;i++)if(label[start+i]!==key[i])different++;if(different<=Math.floor(key.length/4))return true;}return false;}
const chartEmpty = text => !String(text||'').trim() || /^#(?:DIV\/0!|N\/A|VALUE!|REF!|NUM!|NAME\?|NULL!)$/i.test(String(text).trim());
function chartRows(table){
  if(!table?.box||table.rows?.length<3||table.rows[0]?.length<4)return null;
  const header=table.rows.findIndex(row=>row.slice(1).filter(text=>String(text||'').trim()&&number(text)===null&&!chartEmpty(text)).length>=Math.max(2,(row.length-1)*.3));
  if(header<0)return null;
  const columns=table.rows[header].slice(1).map((text,index)=>({text:String(text||'').trim().replace(/(\d['’]?)0ct/gi,'$1Oct'),index:index+1})).filter(item=>!/(?:合[計计]|[總总][計计]|total|sum)/i.test(item.text));
  if(columns.length<3)return null;
  const rows=[];
  for(let r=header+1;r<table.rows.length;r++){
    const row=table.rows[r],name=String(row[0]||'').trim();if(!name)continue;
    const raw=columns.map(({index})=>String(row[index]||'').trim()),values=raw.map(number);
    if(!values.some(value=>value!==null))continue;
    rows.push({name,values,raw,row:r,percent:raw.some(value=>value.includes('%')),invalid:raw.some((value,index)=>values[index]===null&&!chartEmpty(value))});
  }
  return rows.length>=2?{categories:columns.map(item=>item.text),rows,header}:null;
}
function chartGrid(horizontal,source,table,tables,direction){
  const [x,y,w,h]=table.box,overlaps=other=>Math.min(x+w,other.box[0]+other.box[2])-Math.max(x,other.box[0])>Math.min(w,other.box[2])*.35;
  let low=direction==='above'?Math.floor(source.height*.12):Math.ceil(y+h+3),high=direction==='above'?Math.floor(y+2):Math.floor(source.height*.88);
  for(const other of tables){if(other===table||!overlaps(other))continue;const [,, ,oh]=other.box,oy=other.box[1];if(direction==='above'&&oy+oh<y-5)low=Math.max(low,Math.ceil(oy+oh+3));if(direction==='below'&&oy>y+h+5)high=Math.min(high,Math.floor(oy-3));}
  if(high-low<45)return null;
  const counts=new Uint32Array(source.height),lefts=new Map(),rights=new Map();
  for(let row=low;row<=high;row++){
    let count=0,left=x+w,right=x;for(let col=Math.max(0,x);col<Math.min(source.width,x+w);col++)if(horizontal.data[row*source.width+col]){count++;left=Math.min(left,col);right=Math.max(right,col);}
    if(count>w*.48){counts[row]=count;lefts.set(row,left);rights.set(row,right);}
  }
  const ys=positions(counts,w*.48).filter(value=>value>=low&&value<=high),groups=[];
  for(const row of ys){if(!groups.length||row-groups.at(-1).at(-1)>Math.max(75,source.height*.12))groups.push([row]);else groups.at(-1).push(row);}
  const good=groups.filter(group=>group.length>=3&&group.at(-1)-group[0]>40).sort((a,b)=>b.length-a.length||Math.abs((direction==='above'?a.at(-1):a[0])-(direction==='above'?y:y+h))-Math.abs((direction==='above'?b.at(-1):b[0])-(direction==='above'?y:y+h)));
  if(!good.length)return null;const chosen=good[0],starts=[],ends=[];
  for(const row of chosen){for(let delta=-2;delta<=2;delta++)if(lefts.has(row+delta)){starts.push(lefts.get(row+delta));ends.push(rights.get(row+delta));}}
  const left=median(starts),right=median(ends);return {box:[left,chosen[0],right-left,chosen.at(-1)-chosen[0]],ys:chosen,direction};
}
function chartTickGrid(horizontal,source,table,tables,direction,lines){
  const [x,y,w,h]=table.box,low=direction==='above'?source.height*.12:y+h-8,high=direction==='above'?y+12:source.height*.9;
  let minimum=low,maximum=high;
  for(const other of tables){if(other===table||Math.min(x+w,other.box[0]+other.box[2])-Math.max(x,other.box[0])<w*.35)continue;
    if(direction==='above'&&other.box[1]+other.box[3]<y-5)minimum=Math.max(minimum,other.box[1]+other.box[3]+3);
    if(direction==='below'&&other.box[1]>y+h+5)maximum=Math.min(maximum,other.box[1]+12);
  }
  const groups=[];
  for(const line of lines.filter(line=>{const [cx,cy]=center(line);return number(line.text)!==null&&cy>=minimum&&cy<=maximum&&cx>x-80&&cx<x+w*.18;}).sort((a,b)=>center(a)[0]-center(b)[0])){
    const cx=center(line)[0];if(!groups.length||cx-median(groups.at(-1).map(member=>center(member)[0]))>30)groups.push([line]);else groups.at(-1).push(line);
  }
  const candidates=[];
  for(const group of groups){for(const percent of [false,true]){
    const members=group.filter(line=>line.text.includes('%')===percent).sort((a,b)=>center(a)[1]-center(b)[1]);
    if(members.length<4||new Set(members.map(line=>number(line.text))).size<4)continue;
    const descending=members.slice(1).filter((line,index)=>number(line.text)<=number(members[index].text)).length;
    if(descending<members.length-2||center(members.at(-1))[1]-center(members[0])[1]<60)continue;
    const unique=[...new Set(members.map(line=>number(line.text)))].sort((a,b)=>a-b),step=median(unique.slice(1).map((value,index)=>value-unique[index])),base=unique[0];
    const regular=members.filter(line=>{const value=number(line.text),index=(value-base)/step;return Math.abs(index-Math.round(index))<.03&&index<=members.length+2;});
    if(regular.length>=4)candidates.push(regular);
  }}
  if(!candidates.length)return null;
  candidates.sort((a,b)=>b.length-a.length);const ticks=candidates[0],top=center(ticks[0])[1],bottom=center(ticks.at(-1))[1],starts=[],ends=[];
  for(let row=Math.max(0,Math.floor(top)-4);row<Math.min(source.height,Math.ceil(bottom)+4);row++){
    let left=x+w,right=x,count=0;for(let col=Math.floor(x);col<x+w;col++)if(horizontal.data[row*source.width+col]){count++;left=Math.min(left,col);right=Math.max(right,col);}
    if(count>w*.48){starts.push(left);ends.push(right);}
  }
  const axisLeft=Math.max(...ticks.map(line=>line.box[0]+line.box[2]))+20,left=starts.length?Math.min(median(starts),axisLeft):axisLeft,right=ends.length?median(ends):x+w-18;
  return {box:[left,top,right-left,bottom-top],ys:ticks.map(line=>center(line)[1]),direction,tickEvidence:true};
}
function chartAxis(lines,plotBox,side){
  const [x,y,w,h]=plotBox,members=lines.filter(line=>{const [cx,cy]=center(line);return cy>=y-16&&cy<=y+h+16&&(side==='left'?cx<x+3&&cx>x-100:cx>x+w-3&&cx<x+w+100)&&number(line.text)!==null;});
  if(members.length<2)return null;
  const percent=members.filter(line=>line.text.includes('%')).length>members.length/2;let chosen=members.filter(line=>line.text.includes('%')===percent),values=[...new Set(chosen.map(line=>number(line.text)))].sort((a,b)=>a-b);
  if(values.length<2)return null;
  const steps=values.slice(1).map((value,index)=>Number((value-values[index]).toPrecision(8))).filter(value=>value>0),majorUnit=median(steps);
  if(values.length>=4&&majorUnit){const regular=values.map(base=>values.filter(value=>Math.abs((value-base)/majorUnit-Math.round((value-base)/majorUnit))<.03)).sort((a,b)=>b.length-a.length)[0];if(regular.length>=3){const base=regular[0],keep=regular.filter(value=>value-base<=majorUnit*(members.length+2));chosen=chosen.filter(line=>keep.includes(number(line.text)));values=keep;}}
  const maximum=values.at(-1),minimum=values[0];
  return {min:minimum,max:maximum,majorUnit,formatCode:percent?(chosen.some(line=>/\.\d+%/.test(line.text))?'0.00%':'0%'):'#,##0',percent,visible:true,labelPosition:'nextTo',labelFontSize:median(chosen.map(line=>line.box[3]))*.9,lines:chosen,
    top:median(chosen.filter(line=>number(line.text)===maximum).map(line=>center(line)[1])),bottom:median(chosen.filter(line=>number(line.text)===minimum).map(line=>center(line)[1]))};
}
function chartColor(pixels,width,box,{gray=false}={}){
  const colors=new Map(),[x,y,w,h]=box;
  for(let row=Math.max(0,Math.floor(y));row<Math.floor(y+h);row++)for(let col=Math.max(0,Math.floor(x));col<Math.min(width,Math.floor(x+w));col++){
    const p=(row*width+col)*4,r=pixels[p],g=pixels[p+1],b=pixels[p+2],high=Math.max(r,g,b),low=Math.min(r,g,b);
    const chromatic=high-low>80&&high>90&&low<200;if(!chromatic&&!(gray&&high-low<12&&low>=90&&high<=210))continue;
    const [hue,saturation]=hsv(r,g,b),key=chromatic?`h${Math.round(hue/15)%12}v${Math.floor(high/48)}`:`g${r>>4}`,entry=colors.get(key)||{count:0,peak:0,samples:new Map()};entry.count++;entry.peak=Math.max(entry.peak,saturation);
    const rgb=hex([r,g,b]),sample=entry.samples.get(rgb)||{color:rgb,count:0,saturation};sample.count++;entry.samples.set(rgb,sample);colors.set(key,entry);
  }
  return [...colors.values()].sort((a,b)=>b.count-a.count).map(item=>({color:[...item.samples.values()].filter(sample=>sample.saturation>=item.peak*.93).sort((a,b)=>b.count-a.count)[0].color,count:item.count}));
}
function chartPaint(table,row,pixels,width){
  const y=table.box[1]+table.heights.slice(0,row.row).reduce((a,b)=>a+b,0),height=table.heights[row.row],cell=[table.box[0]+3,y+2,Math.max(1,(table.widths[0]||80)-6),Math.max(1,height-4)];
  const chromatic=chartColor(pixels,width,cell),colors=chromatic.length?chromatic:chartColor(pixels,width,cell,{gray:true});return colors[0]?.count>=12?colors[0].color:null;
}
function chartLineStyle(pixels,width,plot,color){
  if(!color)return {};const rgb=[0,2,4].map(index=>parseInt(color.slice(index,index+2),16)),paintHue=hsv(...rgb)[0],paintV=Math.max(...rgb),[x,y,w,h]=plot,rows=[];
  for(let row=Math.max(0,Math.floor(y));row<y+h;row++){const columns=[];for(let col=Math.floor(x);col<x+w;col++){const p=(row*width+col)*4,[hue,sat,value]=hsv(pixels[p],pixels[p+1],pixels[p+2]),delta=Math.abs(hue-paintHue);if(Math.min(delta,180-delta)<8&&sat>55&&(paintV>210?value>paintV*.78:value>paintV*.62&&value<paintV*1.25))columns.push(col);}if(columns.length>4)rows.push({row,columns});}
  rows.sort((a,b)=>b.columns.length-a.columns.length);if(!rows.length)return {marker:'none'};
  const longest=rows[0],segments=[];for(const col of longest.columns){if(!segments.length||col-segments.at(-1).at(-1)>2)segments.push([col]);else segments.at(-1).push(col);}
  const dotted=segments.length>=8&&median(segments.map(segment=>segment.length))<10&&Math.max(...segments.map(segment=>segment.length))<w*.035&&longest.columns.length>w*.15;
  const thickness=rows.filter(item=>Math.abs(item.row-longest.row)<6&&item.columns.length>longest.columns.length*.75).length;
  return {lineWidth:Math.max(1,Math.min(5,thickness)),dash:dotted?'dot':'solid',marker:'none'};
}
function chartVisiblePoints(series,rows,categories,lines,plotBox){
  const [x,y,w,h]=plotBox,step=w/categories.length;
  for(let s=0;s<series.length;s++){
    const item=series[s];if(item.type!=='line')continue;
    item.values=[...item.values];
    for(let index=0;index<item.values.length;index++){
      if(item.values[index]!==null||!/^#/.test(rows[s].raw[index]))continue;
      const point=x+(index+.5)*step,candidates=lines.filter(line=>{
        const [cx,cy]=center(line),value=number(line.text);
        return value!==null&&line.text.includes('%')===item.percent&&Math.abs(cx-point)<step*.3&&cy>=y-10&&cy<=y+h+13;
      });
      // A visible label uniquely tied to this month is usable data; an Excel
      // formula error or a guessed bar/line height never supplies a number.
      const values=[...new Set(candidates.map(line=>number(line.text)))];if(values.length!==1)continue;
      const label=candidates[0];item.values[index]=values[0];
      (item.visiblePointSources||=[]).push({index,category:categories[index],value:values[0],text:label.text,box:[...label.box],source:'visible chart point label'});
    }
  }
}
function chartFont(line,pixels,width){
  if(line.fontSize>0)return line.fontSize;
  const [x,y,w,h]=line.box,counts=[];
  for(let row=Math.max(0,Math.floor(y));row<Math.ceil(y+h);row++){let count=0;for(let col=Math.max(0,Math.floor(x));col<Math.min(width,Math.ceil(x+w));col++){const p=(row*width+col)*4;if(Math.min(pixels[p],pixels[p+1],pixels[p+2])<175)count++;}if(count>=Math.max(2,w*.04))counts.push(row);}
  const ink=counts.length?counts.at(-1)-counts[0]+1:h;return Math.max(4,Math.min(h*1.1,ink*(/[\u3400-\u9FFF]/.test(line.text)?1.14:1.36)));
}
function chartGridPaint(pixels,width,plot,ys){
  const samples=new Map();for(const y of ys)for(let row=Math.max(0,Math.floor(y)-3);row<=y+3;row++)for(let col=Math.floor(plot[0]);col<plot[0]+plot[2];col+=2){const p=(row*width+col)*4,[r,g,b]=pixels.slice(p,p+3);if(Math.max(r,g,b)-Math.min(r,g,b)<12&&Math.min(r,g,b)>185&&Math.max(r,g,b)<245){const color=hex([r,g,b]);samples.set(color,(samples.get(color)||0)+1);}}
  const common=[...samples].sort((a,b)=>b[1]-a[1]);return common.filter(item=>item[1]>=(common[0]?.[1]||0)*.3).sort((a,b)=>parseInt(a[0],16)-parseInt(b[0],16))[0]?.[0];
}
function chartBarStyle(series,paints,pixels,width,plot,categories){
  const bars=series.filter(item=>item.type==='bar');if(!bars.length)return {};
  const colors=bars.map(item=>[0,2,4].map(i=>parseInt(item.color.slice(i,i+2),16))),[x,y,w,h]=plot,columns=new Uint32Array(Math.ceil(w));
  for(let row=Math.floor(y);row<y+h;row+=2)for(let col=Math.floor(x);col<x+w;col++){const p=(row*width+col)*4;if(colors.some(rgb=>rgb.every((v,i)=>Math.abs(v-pixels[p+i])<28)))columns[col-Math.floor(x)]++;}
  const step=w/categories.length,maximum=Math.max(...bars.flatMap(item=>item.values.filter(value=>value!==null))),groups=[];for(let c=0;c<categories.length;c++){let occupied=0;for(let i=Math.floor(c*step);i<Math.min(columns.length,Math.floor((c+1)*step));i++)if(columns[i]>Math.max(2,h*.015))occupied++;const visible=bars.filter(item=>Math.abs(item.values[c]||0)>maximum*.035).length;if(occupied>4&&visible)groups.push(occupied/visible*bars.length);}
  const gap=groups.length?Math.max(0,Math.min(500,Math.round((step/median(groups)-1)*100))):undefined;
  const shadows=colors.filter(rgb=>paints.some(paint=>{const other=[0,2,4].map(i=>parseInt(paint.color.slice(i,i+2),16)),ratio=Math.max(...other)/Math.max(...rgb);return paint.count>40&&ratio>.45&&ratio<.83&&Math.abs(hsv(...rgb)[0]-hsv(...other)[0])<8;})).length;
  return {...(gap!==undefined?{gapWidth:gap,barOverlap:0}:{}),bar3D:shadows>=2};
}
function chartMarkers(series,primary,secondary,pixels,width,plot,categories){
  for(const item of series.filter(series=>series.type==='line')){
    const axis=item.secondary?secondary:primary;if(!axis||axis.max<=axis.min)continue;
    const rgb=[0,2,4].map(i=>parseInt(item.color.slice(i,i+2),16));let circles=0,points=0;
    for(let index=0;index<item.values.length;index++){
      const value=item.values[index];if(value===null)continue;points++;
      const px=plot[0]+(index+.5)*plot[2]/categories.length,py=plot[1]+(axis.max-value)/(axis.max-axis.min)*plot[3],matches=[];
      for(let y=Math.max(0,Math.round(py)-5);y<=Math.round(py)+5;y++)for(let x=Math.max(0,Math.round(px)-5);x<=Math.round(px)+5;x++){const p=(y*width+x)*4;if(rgb.every((v,i)=>Math.abs(v-pixels[p+i])<30))matches.push([x,y]);}
      if(matches.length){const w=Math.max(...matches.map(p=>p[0]))-Math.min(...matches.map(p=>p[0]))+1,low=Math.min(...matches.map(p=>p[1])),high=Math.max(...matches.map(p=>p[1])),h=high-low+1;if(Math.min(w,h)>=Math.max(5,(item.lineWidth||1)+2)&&h<10&&Math.abs((low+high)/2-py)<2)circles++;}
    }
    if(circles>=Math.min(3,Math.max(2,points*.2)))item.marker='circle';
  }
}
function chartDetails(table,data,grid,source,pixels,lines){
  let plotBox=[...grid.box],primary=chartAxis(lines,plotBox,'left'),secondary=chartAxis(lines,plotBox,'right');
  const axes=primary?.lines.length>=4?[primary]:[primary,secondary].filter(Boolean);if(axes.length){const top=median(axes.map(axis=>axis.top)),bottom=median(axes.map(axis=>axis.bottom));if(bottom-top>40)plotBox=[plotBox[0],top,plotBox[2],bottom-top];}
  // Missing axis OCR labels can be recovered as style from aligned linear
  // tick spacing. This never changes a table cell or a plotted series value.
  for(const axis of [primary,secondary].filter(Boolean))if(axis.lines.length>=3&&axis.majorUnit){
    const ticks=axis.lines.map(line=>({y:center(line)[1],value:number(line.text)})),meanY=ticks.reduce((n,p)=>n+p.y,0)/ticks.length,meanV=ticks.reduce((n,p)=>n+p.value,0)/ticks.length,den=ticks.reduce((n,p)=>n+(p.y-meanY)**2,0),slope=den?ticks.reduce((n,p)=>n+(p.y-meanY)*(p.value-meanV),0)/den:0;
    const error=ticks.reduce((n,p)=>n+Math.abs(p.value-(meanV+slope*(p.y-meanY))),0)/ticks.length;
    if(slope<0&&error<axis.majorUnit*.08){const high=Math.round((meanV+slope*(plotBox[1]-meanY))/axis.majorUnit)*axis.majorUnit,low=Math.round((meanV+slope*(plotBox[1]+plotBox[3]-meanY))/axis.majorUnit)*axis.majorUnit;if(high>=axis.max&&low<=axis.min&&high-axis.max<=axis.majorUnit*4&&axis.min-low<=axis.majorUnit*4){if(high!==axis.max||low!==axis.min)axis.evidence={method:'visible linear ticks aligned to source plot grid',tickValues:ticks.map(p=>p.value),derivedEndpoints:true};axis.max=Number(high.toPrecision(10));axis.min=Number(low.toPrecision(10));}}
  }
  const [px,py,pw,ph]=plotBox,below=grid.direction==='below',legendLines=lines.filter(line=>center(line)[0]>=px-50&&center(line)[0]<=px+pw+50&&center(line)[1]>py+ph+8&&center(line)[1]<Math.min(source.height,py+ph+85)&&!inside(center(line),table.box));
  const matched=data.rows.filter(row=>legendLines.some(line=>chartLabelMatch(line.text,row.name)));
  const paints=chartColor(pixels,source.width,plotBox,{gray:true}),colored=paints.filter(item=>item.count>30&&Math.max(...[0,2,4].map(i=>parseInt(item.color.slice(i,i+2),16)))-Math.min(...[0,2,4].map(i=>parseInt(item.color.slice(i,i+2),16)))>80),hasBars=colored.some(paint=>{
    const rgb=[0,2,4].map(index=>parseInt(paint.color.slice(index,index+2),16));let block=0;for(let row=Math.floor(py);row<py+ph;row+=3)for(let col=Math.floor(px);col<px+pw-5;col+=3){const p=(row*source.width+col)*4,q=p+20;if(rgb.every((v,i)=>Math.abs(v-pixels[p+i])<25&&Math.abs(v-pixels[q+i])<25))block++;}return block>pw*ph*.005;
  });
  let selected=matched.length>=2?matched:data.rows;if(!matched.length&&colored.length>=2&&data.rows.some(row=>row.percent)&&!hasBars)selected=data.rows.filter(row=>row.percent);
  if(selected.length<2||selected.some(row=>row.invalid))return null;
  const series=selected.map((row,index)=>{
    let paint=chartPaint(table,row,pixels,source.width);if(paint&&row.percent){const rgb=[0,2,4].map(i=>parseInt(paint.slice(i,i+2),16));if(Math.max(...rgb)-Math.min(...rgb)<50)paint=null;}if(paint&&!paints.some(item=>{const a=[0,2,4].map(i=>parseInt(paint.slice(i,i+2),16)),b=[0,2,4].map(i=>parseInt(item.color.slice(i,i+2),16));return a.every((v,i)=>Math.abs(v-b[i])<45);}))paint=null;
    if(!paint){const same=selected.filter(item=>item.percent===row.percent),position=same.indexOf(row),options=colored.filter(item=>!selected.some(other=>other!==row&&chartPaint(table,other,pixels,source.width)===item.color));paint=options[position]?.color||paints[index]?.color||['4472C4','ED7D31','70AD47','C00000'][index%4];}
    const decimals=Math.min(6,Math.max(0,...row.raw.map(value=>value.match(/\.(\d+)%$/)?.[1].length||0)));
    return {name:row.name,values:row.values,type:row.percent?'line':'bar',percent:row.percent,formatCode:row.percent?`0${decimals?'.'+'0'.repeat(decimals):''}%`:'#,##0',secondary:secondary&&primary?row.percent!==primary.percent:primary?row.percent!==primary.percent:!row.percent&&selected.some(item=>item.percent),color:paint,...(row.percent?chartLineStyle(pixels,source.width,plotBox,paint):{})};
  });
  // A line-only rate plot commonly has a red constant target and a blue actual.
  // Match the visible horizontal colored line rather than using row order.
  for(const item of series.filter(item=>item.type==='line'&&item.values.filter(v=>v!==null).every(v=>v===item.values.find(n=>n!==null)))){
    let best=null;for(const paint of colored){const style=chartLineStyle(pixels,source.width,plotBox,paint.color),rgb=[0,2,4].map(i=>parseInt(paint.color.slice(i,i+2),16));let longest=0;for(let row=Math.floor(py);row<py+ph;row++){let count=0;for(let col=Math.floor(px);col<px+pw;col++){const p=(row*source.width+col)*4;if(rgb.every((v,i)=>Math.abs(v-pixels[p+i])<25))count++;}longest=Math.max(longest,count);}if(longest>pw*.35&&(!best||longest>best.longest))best={...paint,...style,longest};}
    if(best&&!chartPaint(table,selected[series.indexOf(item)],pixels,source.width)){const old=item.color;item.color=best.color;Object.assign(item,{lineWidth:best.lineWidth,dash:best.dash,marker:best.marker});for(const other of series)if(other!==item&&other.color===best.color)other.color=old;}
  }
  chartVisiblePoints(series,selected,data.categories,lines,plotBox);
  chartMarkers(series,primary,secondary,pixels,source.width,plotBox,data.categories);
  const titles=lines.filter(line=>{const [cx,cy]=center(line);return cy<py-5&&cy>py-80&&Math.abs(cx-(px+pw/2))<pw*.25&&number(line.text)===null&&!data.categories.includes(line.text)&&!selected.some(row=>chartName(row.name)===chartName(line.text))&&!inside(center(line),table.box);}).sort((a,b)=>b.box[1]-a.box[1]);
  const title=titles[0],numericLabels=lines.filter(line=>inside(center(line),plotBox)&&number(line.text)!==null),showValues=numericLabels.length>=Math.max(3,data.categories.filter(Boolean).length*.4),legend=matched.length>=2;
  for(const item of series){const matching=numericLabels.filter(line=>line.text.includes('%')===item.percent&&item.values.some(value=>value!==null&&Math.abs(value-number(line.text))<Math.max(1e-6,Math.abs(value)*.00005)));item.showValues=item.type==='bar'?showValues:matching.length>=Math.max(2,data.categories.filter(Boolean).length*.25);}
  const left=Math.min(px-8,...(primary?.lines||[]).map(line=>line.box[0]))-4,right=Math.max(px+pw+8,...(secondary?.lines||[]).map(line=>line.box[0]+line.box[2]))+4,top=title?Math.min(title.box[1]-6,py-8):py-8,bottom=below?Math.min(source.height,Math.max(py+ph+30,...(legend?legendLines:[]).map(line=>line.box[1]+line.box[3]+7))):Math.min(table.box[1],py+ph+3);
  const barStyle=chartBarStyle(series,paints,pixels,source.width,plotBox,data.categories),chart={box:bounds([left,top,right-left,bottom-top],source.width,source.height),plotBox,type:series.every(item=>item.type==='line')?'line':series.every(item=>item.type==='bar')?'bar':'combo',categories:data.categories,series,colors:series.map(item=>item.color),legendPosition:legend?'b':'none',showValues,fontSize:median(lines.filter(line=>number(line.text)!==null&&inside(center(line),[left,top,right-left,bottom-top])).map(line=>chartFont(line,pixels,source.width)))||12,categoryAxis:{visible:below},sourceTableBox:[...table.box],dataSource:'visible data table',style:{background:'FFFFFF',bar3D:barStyle.bar3D,...(barStyle.bar3D?{rightAngleAxes:true}:{})},...barStyle};
  if(title){chart.title=title.text;chart.titleFontSize=chartFont(title,pixels,source.width);}
  if(legend)chart.legendFontSize=median(legendLines.map(line=>chartFont(line,pixels,source.width)));
  for(const [name,axis]of [['primaryAxis',primary],['secondaryAxis',secondary]])if(axis){const {lines:members,top:axisTop,bottom:axisBottom,percent,...meta}=axis;chart[name]={...meta,labelFontSize:median(members.map(line=>chartFont(line,pixels,source.width))),gridColor:name==='primaryAxis'?chartGridPaint(pixels,source.width,plotBox,grid.ys):undefined,gridWidth:name==='primaryAxis'?1:0};}
  if(series.some(item=>item.values.some(value=>value===null)))chart.missingData='gap';
  return chart;
}
export function chartsFromTables(input,source,cv,lines=[]){
  const tables=input.map(item=>item?.table||item).filter(table=>table?.box&&table.rows),datasets=tables.map(table=>({table,data:chartRows(table)})).filter(item=>item.data);
  if(!datasets.length)return [];
  const rgba=cv.imread(source),gray=new cv.Mat(),edges=new cv.Mat(),pixels=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;let closed,horizontal;
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);cv.Canny(gray,edges,20,60);closed=morph(cv,edges,cv.MORPH_CLOSE,5,1);horizontal=morph(cv,closed,cv.MORPH_OPEN,Math.max(15,source.width/75),1);
    const charts=[];
    for(const {table,data}of datasets){
      const grids=['above','below'].map(direction=>chartTickGrid(horizontal,source,table,tables,direction,lines)||chartGrid(horizontal,source,table,tables,direction)).filter(Boolean).sort((a,b)=>Number(Boolean(b.tickEvidence))-Number(Boolean(a.tickEvidence))||Math.abs((a.direction==='above'?a.box[1]+a.box[3]:a.box[1])-(a.direction==='above'?table.box[1]:table.box[1]+table.box[3]))-Math.abs((b.direction==='above'?b.box[1]+b.box[3]:b.box[1])-(b.direction==='above'?table.box[1]:table.box[1]+table.box[3]))),grid=grids[0];if(!grid)continue;
      const chart=chartDetails(table,data,grid,source,pixels,lines);if(chart&&!charts.some(other=>inside(center({box:chart.plotBox}),other.plotBox)))charts.push(chart);
    }
    return charts.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]);
  }finally{free(rgba,gray,edges,closed,horizontal);}
}
function chartFromTable(table,source,cv){return chartsFromTables(table?[table]:[],source,cv)[0]||null;}

function vectors(source,pixels,contours,excluded){
  const found=[];
  for(const item of contours){
    const {box:[x,y,w,h],area,points}=item;
    if(Math.min(w,h)<22||area<400||w>source.width*.94||h>source.height*.9||excluded.some(box=>inside([x+w/2,y+h/2],box)||inside(center({box}),[x,y,w,h])&&box[2]*box[3]>w*h*.04))continue;
    if(found.some(other=>Math.abs(x-other.box[0])<7&&Math.abs(y-other.box[1])<7&&Math.abs(w-other.box[2])<14&&Math.abs(h-other.box[3])<14))continue;
    const sample=region(pixels,source.width,[x+2,y+2,w-4,h-4]),ratio=area/(w*h);let kind=null;
    const diamondTips=points.length>=4&&points.length<=10&&[points.filter(([px])=>px<=x+w*.05),points.filter(([px])=>px>=x+w*.95)].every(tips=>tips.length&&tips.every(([,py])=>Math.abs(py-y-h/2)<h*.22))&&[points.filter(([,py])=>py<=y+h*.05),points.filter(([,py])=>py>=y+h*.95)].every(tips=>tips.length&&tips.every(([px])=>Math.abs(px-x-w/2)<w*.22));
    const tip=points.filter(point=>point[0]>=x+w-Math.max(2,w*.01));
    if(ratio>.38&&ratio<.65&&(points.length===4||diamondTips))kind='diamond';
    else if(points.length>=5&&points.length<=14&&ratio>.35&&ratio<.985&&sample.two>.8&&w>h*1.1&&tip.length===1&&Math.abs(tip[0][1]-y-h/2)<h*.22)kind='rightArrow';
    else if(points.length===4&&ratio>.86&&sample.uniform>.65||ratio>.93&&sample.uniform>.85)kind='rect';
    else if(points.length>=6&&points.length<=12&&ratio>.82&&sample.uniform>.6)kind='roundRect';
    if(!kind)continue;
    const stroke=region(pixels,source.width,[x,y,w,h],(index,col,row)=>(col<x+3||row<y+3||col>x+w-4||row>y+h-4)&&Math.min(pixels[index],pixels[index+1],pixels[index+2])<180).rgb;
    // Pale slide cards have separate positioned paragraphs. Treating their
    // container as one flow node would collapse that paragraph spacing.
    if(kind==='rect'&&Math.min(...sample.rgb)>225){
      const edges=[[[x,y,w,3]],[[x,y+h-3,w,3]],[[x,y,3,h]],[[x+w-3,y,3,h]]].map(([box])=>{const dark=region(pixels,source.width,box,index=>Math.min(pixels[index],pixels[index+1],pixels[index+2])<180);return dark.count/(box[2]*box[3]);});
      if(edges.filter(value=>value>.3).length<3)continue;
    }
    const polygonColor=['diamond','rightArrow'].includes(kind)?region(pixels,source.width,[x+2,y+2,w-4,h-4],(_,col,row)=>{let covered=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const [ax,ay]=points[i],[bx,by]=points[j];if((ay>row)!==(by>row)&&col<(bx-ax)*(row-ay)/(by-ay)+ax)covered=!covered;}return covered;}).rgb:sample.rgb;
    found.push({box:[x,y,w,h],kind,fill:hex(polygonColor),line:hex(stroke),width:2,points});
  }
  return found.filter(shape=>!(['roundRect','rightArrow'].includes(shape.kind)&&found.some(other=>other.kind==='rect'&&Math.abs(other.box[0]-shape.box[0])<5&&Math.abs(other.box[1]-shape.box[1])<5&&other.box[2]*other.box[3]>shape.box[2]*shape.box[3]*(shape.kind==='rightArrow'?.38:.7))));
}
// Fine grayscale report/drawing strokes are an embedded image even when their
// palette is almost entirely white. The normal photo entropy check misses them.
function embeddedPictures(source,pixels,lines,cv){
  const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);let closed;
  try{
    for(let i=0;i<mask.data.length;i++){const p=i*4,low=Math.min(pixels[p],pixels[p+1],pixels[p+2]),high=Math.max(pixels[p],pixels[p+1],pixels[p+2]);mask.data[i]=low<205&&high-low<20?255:0;}
    const typical=median(lines.filter(line=>line.box[3]>=12).map(line=>line.box[3]))||18;
    // Body text is editable. Smaller labels inside a dense drawing/report belong
    // to that image, as do vertical dimension annotations.
    clearBoxes(mask.data,source.width,source.height,lines.filter(line=>!line.preserveImage&&line.box[3]>=Math.max(16,typical*.8)).map(line=>line.box),2);
    closed=morph(cv,mask,cv.MORPH_CLOSE,9,9);
    const found=[];
    for(const {box:[x,y,w,h]}of components(cv,closed)){
      if(w<90||h<65||w>source.width*.68||h>source.height*.65)continue;
      let ink=0,hRules=0,vRules=0;const rowHits=new Uint8Array(h),columnHits=new Uint8Array(w);
      for(let row=y;row<y+h;row++){let count=0;for(let col=x;col<x+w;col++)if(mask.data[row*source.width+col]){count++;ink++;}if(count>w*.45){hRules++;rowHits[row-y]=1;}}
      for(let col=x;col<x+w;col++){let count=0;for(let row=y;row<y+h;row++)if(mask.data[row*source.width+col])count++;if(count>h*.45){vRules++;columnHits[col-x]=1;}}
      if(ink<120||ink/(w*h)<.02||ink/(w*h)>.35||hRules<3||vRules<3)continue;
      const members=lines.filter(line=>inside(center(line),[x,y,w,h])),small=members.filter(line=>line.box[3]<typical*.8||line.preserveImage);
      if(members.length&&small.length/members.length<.5)continue;
      const document=positions(rowHits,1).length>=8&&positions(columnHits,1).length>=6;
      if(document&&members.length&&median(members.map(line=>line.box[3]))>=Math.max(14,typical*.72))continue;
      const box=bounds([x,y,w,h],source.width,source.height,Math.max(12,Math.min(w,h)*.15));
      for(const line of lines.filter(line=>line.box[3]>=Math.max(16,typical*.8)&&!line.preserveImage&&[...line.text].length>=6)){
        const [lx,ly,lw,lh]=line.box;
        if(Math.min(x+w,lx+lw)-Math.max(x,lx)<=0)continue;
        if(ly>=y+h&&ly<box[1]+box[3])box[3]=Math.max(1,ly-1-box[1]);
        if(ly+lh<=y&&ly+lh>box[1]){const bottom=box[1]+box[3];box[1]=ly+lh+1;box[3]=bottom-box[1];}
      }
      if(found.some(other=>inside(center({box}),other.box)))continue;
      found.push({box,kind:document?'document':'drawing',canvas:crop(source,box)});
    }
    return found;
  }finally{free(mask,closed);}
}
function pictures(source,pixels,lines,excluded,cv){
  const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);let opened,closed,colorful,colorClosed;
  const found=[];
  try{
    for(let i=0;i<mask.data.length;i++){const p=i*4;mask.data[i]=Math.min(pixels[p],pixels[p+1],pixels[p+2])<225?255:0;}
    clearBoxes(mask.data,source.width,source.height,excluded,2);opened=morph(cv,mask,cv.MORPH_OPEN,3,3);closed=morph(cv,opened,cv.MORPH_CLOSE,7,7);
    for(const {box:[x,y,w,h],area}of components(cv,closed)){
      if(Math.min(w,h)<55||area/(w*h)<.4||w>source.width*.7||h>source.height*.88)continue;
      const sample=region(pixels,source.width,[x,y,w,h]);if(sample.colors<12||sample.uniform>.8||sample.two>.88&&Math.max(...sample.rgb)-Math.min(...sample.rgb)>50)continue;
      const textArea=lines.reduce((sum,line)=>sum+Math.max(0,Math.min(x+w,line.box[0]+line.box[2])-Math.max(x,line.box[0]))*Math.max(0,Math.min(y+h,line.box[1]+line.box[3])-Math.max(y,line.box[1])),0);
      if(textArea/(w*h)>.2)continue;
      if(lines.filter(line=>inside(center(line),[x,y,w,h])).length>=3&&sample.uniform>.25)continue;
      found.push({box:[x,y,w,h]});
    }
    colorful=new cv.Mat(source.height,source.width,cv.CV_8UC1);
    for(let i=0;i<colorful.data.length;i++){const p=i*4;colorful.data[i]=Math.max(pixels[p],pixels[p+1],pixels[p+2])-Math.min(pixels[p],pixels[p+1],pixels[p+2])>80?255:0;}
    clearBoxes(colorful.data,source.width,source.height,excluded,2);
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
function tableSwatches(source,pixels,tables,charts,cv){
  if(!charts.length)return [];
  const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);mask.data.fill(0);const regions=[];
  try{
    for(const table of tables.filter(table=>charts.some(chart=>chart.sourceTableBox?.every((value,i)=>Math.abs(value-table.box[i])<5)))){
      let y=table.box[1]+table.heights[0];
      for(let r=1;r<table.rows.length;r++){
        const box=bounds([table.box[0]+3,y+2,Math.max(1,table.widths[0]*.35-5),table.heights[r]-4],source.width,source.height);regions.push({box,height:table.heights[r],width:table.widths[0]});
        for(let row=box[1];row<box[1]+box[3];row++)for(let col=box[0];col<box[0]+box[2];col++){const p=(row*source.width+col)*4,low=Math.min(pixels[p],pixels[p+1],pixels[p+2]),high=Math.max(pixels[p],pixels[p+1],pixels[p+2]);if(low<120&&(high-low>40||high<90))mask.data[row*source.width+col]=255;}
        y+=table.heights[r];
      }
    }
    return components(cv,mask).flatMap(({box:[x,y,w,h],area})=>{
      const cell=regions.find(cell=>inside([x+w/2,y+h/2],cell.box));if(!cell||w<6||w>cell.width*.4||h>cell.height*.45||w<h*2.5||area/(w*h)<.3)return [];
      return [{x1:x,y1:y+h/2,x2:x+w,y2:y+h/2,color:hex(region(pixels,source.width,[x,y,w,h],(_,col,row)=>mask.data[row*source.width+col]).rgb),width:Math.max(1,h),arrow:false,box:[x,y,w,h]}];
    });
  }finally{mask.delete();}
}
function connectors(source,pixels,excluded,cv,objects=[]){
  const bins=new Int8Array(source.width*source.height);bins.fill(-1);const counts=new Map(),output=[];
  for(let i=0;i<bins.length;i++){const p=i*4,[h,s,v]=hsv(pixels[p],pixels[p+1],pixels[p+2]);let bin=-1;if(s>90&&v>100)bin=Math.floor(h/10);else if(s<60&&v<185)bin=18;if(bin>=0){bins[i]=bin;counts.set(bin,(counts.get(bin)||0)+1);}}
  for(const [bin,count]of counts){
    if(count<15)continue;
    const mask=new cv.Mat(source.height,source.width,cv.CV_8UC1);
    try{
      for(let i=0;i<bins.length;i++)mask.data[i]=bins[i]===bin?255:0;clearBoxes(mask.data,source.width,source.height,excluded);if(bin===18)clearBoxes(mask.data,source.width,source.height,objects);
      for(const {box:[x,y,w,h],area}of components(cv,mask)){
        const nearby=objects.filter(([ox,oy,ow,oh])=>Math.max(0,ox-x-w,x-ox-ow,oy-y-h,y-oy-oh)<=Math.max(15,Math.max(w,h)*.8)).length>=2;
        if(Math.max(w,h)<(nearby?6:15)||(!nearby&&area/(w*h)>=.22&&Math.min(w,h)>4)||Math.max(w,h)<=Math.min(w,h)*1.4)continue;
        const rgb=region(pixels,source.width,[x,y,w,h],(_,col,row)=>mask.data[row*source.width+col]).rgb;
        if(w>source.width*.2&&h>=8&&w>h*4){
          // Padded OCR boxes can erase one side of a closed legend frame.
          // Confirm closure in the original pixels, including faint antialiasing,
          // before treating the remaining frame edge as an arrow.
          const sourceRows=new Uint32Array(h),sourceColumns=new Uint32Array(w);
          for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){
            const p=(row*source.width+col)*4,[hue,saturation,value]=hsv(pixels[p],pixels[p+1],pixels[p+2]),same=bin===18?saturation<60&&value<185:saturation>30&&value>100&&Math.min(Math.abs(hue/10-bin-.5),18-Math.abs(hue/10-bin-.5))<1.1;
            if(same){sourceRows[row-y]++;sourceColumns[col-x]++;}
          }
          if(positions(sourceRows,w*.6).length>=2&&positions(sourceColumns,h*.5).length>=2)continue;
          const columns=[],rows=[];for(let col=x;col<x+w;col++){let count=0;for(let row=y;row<y+h;row++)if(mask.data[row*source.width+col])count++;columns.push(count);}for(let row=y;row<y+h;row++){let count=0;for(let col=x;col<x+w;col++)if(mask.data[row*source.width+col])count++;rows.push(count);}
          // Two long horizontal and vertical sides form a panel frame, not a
          // return connector. Keep its original outline behind native text.
          if(positions(rows,w*.6).length>=2&&positions(columns,h*.5).length>=2)continue;
          const shafts=positions(columns,Math.max(4,h*.3)),maximum=Math.max(...rows),shaftY=y+rows.indexOf(maximum);
          if(shafts.length>=2&&maximum>w*.6){
            let left=x+w,right=x;for(let col=x;col<x+w;col++)if(mask.data[shaftY*source.width+col]){left=Math.min(left,col);right=Math.max(right,col);}
            output.push({x1:left,y1:shaftY,x2:right,y2:shaftY,color:hex(rgb),width:Math.max(1,rows.filter(count=>count>maximum*.8).length),arrow:false,box:[x,y,w,h]});
            for(const relative of [shafts[0],shafts.at(-1)]){
              let refined=relative;for(let candidate=Math.max(0,relative-12);candidate<=Math.min(w-1,relative+12);candidate++)if(columns[candidate]>columns[refined])refined=candidate;
              const col=x+refined,hits=[];for(let row=y;row<y+h;row++)if([col-1,col,col+1].some(column=>mask.data[row*source.width+column]))hits.push(row);if(hits.length<4)continue;
              const top=hits[0],bottom=hits.at(-1),tipCounts=[];for(let row=top;row<=bottom;row++){let count=0;if(Math.abs(row-shaftY)>1)for(let column=Math.max(x,col-8);column<=Math.min(x+w-1,col+8);column++)if(mask.data[row*source.width+column])count++;tipCounts.push(count);}const step=Math.max(2,Math.ceil(tipCounts.length*.35)),first=Math.max(...tipCounts.slice(0,step)),last=Math.max(...tipCounts.slice(-step)),reverse=first>last+2;
              const endpoint=Math.abs(top-shaftY)>Math.abs(bottom-shaftY)?top:bottom;
              output.push({x1:col,y1:shaftY,x2:col,y2:endpoint,color:hex(rgb),width:1,arrow:Math.max(...tipCounts)>=5,box:[Math.max(x,col-8),top,Math.min(17,w),bottom-top+1]});
            }
            continue;
          }
        }
        if(w>h){let position=0,maximum=0;const counts=[];for(let row=y;row<y+h;row++){let n=0;for(let col=x;col<x+w;col++)if(mask.data[row*source.width+col])n++;if(n>maximum){maximum=n;position=row;}}for(let col=x;col<x+w;col++){let n=0;for(let row=y;row<y+h;row++)if(mask.data[row*source.width+col])n++;counts.push(n);}const step=Math.max(2,Math.ceil(w*.35)),first=Math.max(...counts.slice(0,step)),last=Math.max(...counts.slice(-step)),reverse=first>last+1;output.push({x1:reverse?x+w:x,y1:position,x2:reverse?x:x+w,y2:position,color:hex(rgb),width:1,arrow:Math.max(first,last)>=Math.max(4,Math.min(first,last)+2)});}
        else{const counts=[];for(let row=y;row<y+h;row++){let n=0;for(let col=x;col<x+w;col++)if(mask.data[row*source.width+col])n++;counts.push(n);}const step=Math.max(2,Math.ceil(h*.35)),first=Math.max(...counts.slice(0,step)),last=Math.max(...counts.slice(-step)),reverse=first>last+1;output.push({x1:x+w/2,y1:reverse?y+h:y,x2:x+w/2,y2:reverse?y:y+h,color:hex(rgb),width:1,arrow:Math.max(first,last)>=Math.max(4,Math.min(first,last)+2)});}
      }
    }finally{mask.delete();}
  }return output;
}

function fontInkDensity(text,family,bold,probe){
  const context=probe.getContext('2d'),font=`${bold?'bold ':''}100px "${family}"`;context.font=font;
  const metrics=context.measureText(text),w=metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight,h=metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent;
  if(!(w>0&&h>0)||w>4096)return null;
  probe.width=Math.ceil(w)+4;probe.height=Math.ceil(h)+4;context.font=font;context.fillStyle='black';
  context.fillText(text,metrics.actualBoundingBoxLeft+2,metrics.actualBoundingBoxAscent+2);
  const data=context.getImageData(0,0,probe.width,probe.height).data;let mass=0;
  for(let p=3;p<data.length;p+=4)mass+=data[p]/255;
  return mass/(w*h);
}
function typographyRuleAxes(mask,rowCounts,columnCounts,pixels,width,height,box){
  const [x,y,w,h]=box,rows=new Uint8Array(h),columns=new Uint8Array(w);
  const continues=(sx,sy,dx,dy,rgb)=>{
    let hits=0,total=0;
    for(let step=1;step<=12;step++){const col=sx+dx*step,row=sy+dy*step;if(col<0||row<0||col>=width||row>=height)break;total++;const p=(row*width+col)*4;if(rgb.every((v,i)=>Math.abs(pixels[p+i]-v)<40))hits++;}
    return total>=8&&hits>=total*.8;
  };
  for(let row=0;row<h;row++)if(rowCounts[row]&&(rowCounts[row]>w*.5||row<3||row>=h-3)){
    const rgb=region(pixels,width,[x,y+row,w,1],(_,col)=>mask[row*w+col-x]).rgb,left=continues(x,y+row,-1,0,rgb),right=continues(x+w-1,y+row,1,0,rgb);
    if(left&&right||(row<3||row>=h-3)&&(left||right))rows[row]=1;
  }
  for(let col=0;col<w;col++)if(columnCounts[col]&&(columnCounts[col]>h*.5||col<3||col>=w-3)){
    const rgb=region(pixels,width,[x+col,y,1,h],(_,__,row)=>mask[(row-y)*w+col]).rgb,top=continues(x+col,y,0,-1,rgb),bottom=continues(x+col,y+h-1,0,1,rgb);
    if(top&&bottom||(col<3||col>=w-3)&&(top||bottom))columns[col]=1;
  }
  return {rows,columns};
}
function typography(lines,pixels,width,height){
  const meter=canvas(1,1).getContext('2d');let weightProbe;
  for(const line of lines){
    line.box=bounds(line.box,width,height);const [x,y,w,h]=line.box;if(!w||!h){line.preserveImage=true;continue;}
    if(line.polygon?.length>=2){const [a,b]=line.polygon;if(Math.abs(Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI)>10){line.preserveImage=true;continue;}}
    const bg=region(pixels,width,[x,y,w,h]).rgb;
    const mask=new Uint8Array(w*h),rowCounts=new Uint32Array(h),columnCounts=new Uint32Array(w);
    for(let row=0;row<h;row++)for(let col=0;col<w;col++){const p=((y+row)*width+x+col)*4;if(Math.max(...bg.map((v,i)=>Math.abs(pixels[p+i]-v)))>32){mask[row*w+col]=1;rowCounts[row]++;columnCounts[col]++;}}
    // A table rule or color band continues beyond both ends of the OCR box;
    // a glyph does not. Exclude these pixels from both geometry and text color.
    const rules=typographyRuleAxes(mask,rowCounts,columnCounts,pixels,width,height,line.box),contrasts=[];
    for(let row=0;row<h;row++)for(let col=0;col<w;col++){const index=row*w+col;if(rules.rows[row]||rules.columns[col])mask[index]=0;if(mask[index]){const p=((y+row)*width+x+col)*4;contrasts.push(Math.max(...bg.map((v,i)=>Math.abs(pixels[p+i]-v))));}}
    contrasts.sort((a,b)=>a-b);const strong=contrasts[Math.floor(contrasts.length*.8)]||45;
    let color=region(pixels,width,[x,y,w,h],(p,col,row)=>mask[(row-y)*w+col-x]&&Math.max(...bg.map((v,i)=>Math.abs(pixels[p+i]-v)))>=strong).rgb;
    if(Math.max(...color)-Math.min(...color)<25){const shade=color.reduce((a,b)=>a+b)/3;if(shade<70||shade>225)color=color.map(()=>shade>225?255:0);}
    let left=w,right=-1,top=h,bottom=-1;
    for(let row=0;row<h;row++)for(let col=0;col<w;col++)if(mask[row*w+col]&&!((row<3||row>=h-3)&&rowCounts[row]>w*.8)&&!((col<3||col>=w-3)&&columnCounts[col]>h*.8)){left=Math.min(left,col);right=Math.max(right,col);top=Math.min(top,row);bottom=Math.max(bottom,row);}
    line.fontFamily=line.fontFamily||(/[^\x00-\xff]/.test(line.text)?'Microsoft JhengHei':'Arial');
    let estimated=Math.max(4,Math.min(160,h*1.1,w/Math.max(1,[...line.text].reduce((sum,c)=>sum+(c.codePointAt(0)>255?1:.55),0))));
    if(right>=left&&bottom-top>=3){
      line.inkBox=[x+left,y+top,right-left+1,bottom-top+1];
      // Small raster glyphs do not provide reliable weight evidence. Preserve
      // supplied flags and compare normal/bold ink only on larger single lines.
      if(line.bold==null&&bottom-top+1>=24&&[...line.text].length>=2&&[...line.text].length<=60&&!line.text.includes('\n')){
        let mass=0;
        for(let row=top;row<=bottom;row++)for(let col=left;col<=right;col++)if(mask[row*w+col]){const p=((y+row)*width+x+col)*4;mass+=Math.min(1,Math.max(...bg.map((v,i)=>Math.abs(pixels[p+i]-v)))/strong);}
        weightProbe||=canvas(1,1);
        const normal=fontInkDensity(line.text,line.fontFamily,false,weightProbe),heavy=fontInkDensity(line.text,line.fontFamily,true,weightProbe),density=mass/((right-left+1)*(bottom-top+1));
        if(normal!==null&&heavy!==null&&heavy-normal>.04&&density<=heavy*1.3)line.bold=density>normal+(heavy-normal)*.65;
      }
      meter.font=`${line.bold?'bold ':''}100px "${line.fontFamily}"`;
      const metrics=meter.measureText(line.text.replace(/\n/g,' ')),glyphHeight=metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent,glyphWidth=metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight;
      // Antialiased glyphs can leave a partial ink width. Their visible height
      // sets the size; the whole OCR box remains the text-width guard.
      if(glyphHeight>0&&glyphWidth>0)estimated=Math.max(4,Math.min(160,(bottom-top+1)*100/glyphHeight,w*100/glyphWidth*1.05));
    }
    line.color=hex(color);line.fontSize=line.fontSize||estimated;line.bold=Boolean(line.bold);
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
      try{
        const asText=result=>typeof result==='string'?result:Array.isArray(result)?result.map(line=>typeof line==='string'?line:line.text||'').join(' '):result?.text||result?.lines?.map(line=>line.text).join(' ')||'';
        let text=asText(await recognize(patch,{signal,box:[...box],scale:3,reason}));abort(signal);
        if(!text.trim()){const enhanced=contrastCrop(patch);if(enhanced)try{text=asText(await recognize(enhanced,{signal,box:[...box],scale:3,reason:'contrast-cell'}));abort(signal);}finally{enhanced.width=1;enhanced.height=1;}}
        return text;
      }
      finally{patch.width=1;patch.height=1;}
    })());return cache.get(key);
  }:null;
  const embedded=embeddedPictures(source,pixels,page.lines,cv),contentLines=page.lines.filter(line=>!embedded.some(picture=>inside(center(line),picture.box)));
  const analysisSource=canvas(source.width,source.height),analysisContext=analysisSource.getContext('2d');analysisContext.drawImage(source,0,0);
  for(const picture of embedded){analysisContext.fillStyle='white';analysisContext.fillRect(...picture.box);}
  const contours=contourBoxes(cv,source),tableContours=contourBoxes(cv,analysisSource,false);abort(signal);
  const percent=contentLines.some(line=>line.text.includes('%'));
  const dense=denseGrids(analysisSource,contentLines,cv,tableContours);
  let detected=percent?dense[0]||null:null;
  const local=localGrids(analysisSource,contentLines,cv,tableContours);
  const edgeRuled=grid(analysisSource,contentLines,cv,[0,0],true),inkRuled=grid(analysisSource,contentLines,cv);
  let ruled=edgeRuled||inkRuled;
  if(!ruled)ruled=grid(analysisSource,contentLines,cv,[0,0],245);
  if(percent&&detected){
    const colored=grid(analysisSource,contentLines,cv,[0,0],'color');
    if(colored&&inside(center({box:detected.table.box}),colored.table.box)&&colored.table.box[3]<=detected.table.box[3]*2.2&&colored.table.box[2]<=detected.table.box[2]*2.2&&colored.table.rows.length>=detected.table.rows.length&&colored.table.rows[0].length>=detected.table.rows[0].length)ruled=colored;
  }
  if(edgeRuled&&inkRuled&&edgeRuled.table.rows.length===inkRuled.table.rows.length&&inkRuled.table.rows[0].length>edgeRuled.table.rows[0].length&&edgeRuled.table.box.every((value,i)=>Math.abs(value-inkRuled.table.box[i])<8))ruled=inkRuled;
  // A dense-cell crop can miss its header/legend column. Prefer a nearby enclosing
  // ruled table, while rejecting a plot grid extending far above the data rows.
  if(!detected||(ruled&&inside(center({box:detected.table.box}),ruled.table.box)&&ruled.table.box[3]<=detected.table.box[3]*2.2&&ruled.table.box[2]<=detected.table.box[2]*2.2&&ruled.table.rows.length>=detected.table.rows.length&&ruled.table.rows[0].length>=detected.table.rows[0].length))detected=ruled;
  if(!detected)detected=dense[0]||null;
  if(!detected||detected.table.rows.length<3){const aligned=unruled(analysisSource,contentLines,cv,pixels);if(aligned&&(!detected||aligned.table.rows.length>detected.table.rows.length))detected=aligned;}
  // A local rectangle is stronger evidence than a page-wide rule component
  // joining unrelated cards. Keep independent table bounds and page order.
  let detectedTables=local.length?local:(detected?[detected]:[]);
  if(detected){
    const matching=detectedTables.filter(result=>inside(center({box:result.table.box}),detected.table.box)&&result.table.rows.length===detected.table.rows.length&&Math.abs(result.table.box[1]-detected.table.box[1])<8&&Math.abs(result.table.box[3]-detected.table.box[3])<8&&result.table.rows[0].length<=detected.table.rows[0].length);
    if(matching.length){detectedTables=detectedTables.filter(result=>!matching.includes(result));detectedTables.unshift(detected);}
  }
  for(const candidate of dense){
    if(detectedTables.some(result=>inside(center({box:candidate.table.box}),result.table.box)&&result.table.rows[0].length>=candidate.table.rows[0].length&&result.table.box[3]<=candidate.table.box[3]*2.2))continue;
    detectedTables=detectedTables.filter(result=>!(inside(center({box:result.table.box}),candidate.table.box)||inside(center({box:candidate.table.box}),result.table.box))||result.table.rows[0].length>candidate.table.rows[0].length);
    detectedTables.push(candidate);
  }
  detectedTables=detectedTables.filter(result=>Math.max(...result.table.heights)<=median(result.table.heights)*3.2).sort((a,b)=>a.table.box[1]-b.table.box[1]||a.table.box[0]-b.table.box[0]);
  for(const result of detectedTables){await retryCells(result,recognizeCell,signal);if(result.table.rows.flat().filter(text=>text.includes('%')).length>=5)await retryCells(result,recognizeCell,signal,true);recoveredCellStyles(result,pixels,source.width,source.height);}
  analysisSource.width=1;analysisSource.height=1;
  abort(signal);const nativeTables=detectedTables.map(result=>result.table),table=nativeTables[0]||null,tables=nativeTables.map(table=>({box:table.box,table})),charts=typeof chartsFromTables==='function'?chartsFromTables(nativeTables,source,cv,contentLines):nativeTables.map(table=>chartFromTable(table,source,cv)).filter(Boolean),issues=[];
  const excluded=[...tables,...charts,...embedded].map(item=>item.box),retainedCharts=[];
  if(embedded.some(picture=>picture.kind==='document'))issues.push('內嵌報表的細小儲存格無法可靠辨識，已保留原始圖片；此報表內容仍需原始 Excel/PDF 才能完整編輯。');
  if(embedded.some(picture=>picture.kind==='drawing'))issues.push('內嵌工程圖已保留圖片，其線條／尺寸仍需原始圖檔才能完整編輯。');
  if(detectedTables.some(result=>result.disagreements?.length))issues.push('部分儲存格的原辨識與細格辨識不同，已保留原辨識文字，請核對數字。');
  for(const candidate of nativeTables)if(!charts.some(chart=>chart.sourceTableBox?.every((value,i)=>Math.abs(value-candidate.box[i])<5))&&candidate.rows.flat().filter(text=>text.includes('%')).length>5){issues.push('圖表資料尚未可靠辨識，原圖保留，請核對數字。');const [x,y,w]=candidate.box;if(y>source.height*.3){const box=[x,Math.floor(source.height*.16),w,y-Math.floor(source.height*.16)];retainedCharts.push(box);excluded.push(box);}}
  await tick();abort(signal);
  let shapes=vectors(source,pixels,contours,excluded);
  const photos=[...embedded,...pictures(source,pixels,page.lines,[...excluded,...shapes.map(shape=>shape.box)],cv),...retainedCharts.map(box=>({box,canvas:crop(source,box)}))];
  for(const shape of shapes){
    const members=page.lines.filter(line=>!line.preserveImage&&line.box[2]<=shape.box[2]*1.4&&line.box[3]<=shape.box[3]*1.4&&inside(center(line),shape.box)&&!photos.some(photo=>inside(center(line),photo.box)));
    shape.text=members.sort((a,b)=>a.box[1]-b.box[1]||a.box[0]-b.box[0]).map(line=>line.text).join('\n');shape.lineIndices=members.map(line=>line.index);
    shape.textCoverage=members.reduce((sum,line)=>sum+Math.max(0,Math.min(shape.box[0]+shape.box[2],line.box[0]+line.box[2])-Math.max(shape.box[0],line.box[0]))*Math.max(0,Math.min(shape.box[1]+shape.box[3],line.box[1]+line.box[3])-Math.max(shape.box[1],line.box[1])),0)/(shape.box[2]*shape.box[3]);
    if(members.length){shape.fontSize=members.reduce((sum,line)=>sum+line.fontSize,0)/members.length;shape.textColor=members[0].color;}
  }
  shapes=shapes.filter(shape=>(shape.text&&shape.textCoverage<.65)||shape.kind==='rightArrow'||shape.box[2]>source.width*.65||(!shape.text&&!page.lines.some(line=>{const [x,y,w,h]=shape.box,[lx,ly,lw,lh]=line.box;return Math.max(0,Math.min(x+w,lx+lw)-Math.max(x,lx))*Math.max(0,Math.min(y+h,ly+lh)-Math.max(y,ly))/(w*h)>.25;})));
  shapes=shapes.filter(shape=>!shape.lineIndices?.length||!shapes.some(other=>other!==shape&&other.kind===shape.kind&&other.lineIndices?.join(',')===shape.lineIndices.join(',')&&inside(center({box:other.box}),shape.box)&&other.box[2]*other.box[3]<shape.box[2]*shape.box[3]*.9));
  shapes=shapes.filter(shape=>shape.kind!=='rightArrow'||shape.text||!shapes.some(other=>other!==shape&&other.kind===shape.kind&&!other.text&&other.fill===shape.fill&&other.box[2]*other.box[3]>shape.box[2]*shape.box[3]*1.02&&shape.box[0]>=other.box[0]-3&&shape.box[1]>=other.box[1]-3&&shape.box[0]+shape.box[2]<=other.box[0]+other.box[2]+3&&shape.box[1]+shape.box[3]<=other.box[1]+other.box[3]+3));
  const objects=[...shapes,...photos].map(item=>item.box);
  for(const line of page.lines){if(line.preserveImage)continue;const [cx,cy]=center(line),color=[0,2,4].map(index=>parseInt((line.color||'000000').slice(index,index+2),16));if([...line.text].length<=3&&line.box[2]<35&&line.box[3]<25&&Math.max(...color)-Math.min(...color)>60&&!objects.some(box=>inside([cx,cy],box))&&objects.filter(([x,y,w,h])=>Math.max(0,x-cx,cx-x-w,y-cy,cy-y-h)<30).length>=2)line.preserveImage=true;}
  const lines=[...connectors(source,pixels,[...excluded,...shapes.map(shape=>{const [x,y,w,h]=shape.box;return shape.text?[x+2,y+2,w-4,h-4]:shape.box;}),...photos.map(({box:[x,y,w,h]})=>{const inset=Math.min(8,Math.min(w,h)*.08);return [x+inset,y+inset,w-inset*2,h-inset*2];}),...page.lines.filter(line=>!line.preserveImage).map(line=>line.box)],cv,objects),...tableSwatches(source,pixels,nativeTables,charts,cv)];
  for(const line of page.lines)if(photos.some(photo=>inside(center(line),photo.box)))line.preserveImage=true;
  await tick();abort(signal);
  const backgroundCanvas=eraseText(source,pixels,page.lines,photos.map(photo=>photo.box),cv);
  return {backgroundCanvas,table,tables:nativeTables,analyses:{tables,charts,shapes,pictures:photos,lines,issues}};
}
