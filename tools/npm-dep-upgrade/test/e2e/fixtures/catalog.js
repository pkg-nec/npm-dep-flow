const day=86400000
export const target='e2e-target',parent='e2e-parent-a'
export const ago=days=>new Date(Date.now()-days*day).toISOString()
export function leaf(name,version,extra={}) {return {name,version,main:'index.js',scripts:{postinstall:`node -e "require('fs').writeFileSync('SCRIPT_RAN','bad')"`},...extra}}
export function versions(name=target) {
 return Object.fromEntries(['6.0.9','6.0.10','6.0.12','6.0.13','6.1.0','7.0.5','6.0.14-beta.1'].map(v=>[v,{manifest:leaf(name,v),releasedAt:ago(['6.0.13','6.1.0'].includes(v)?1:20)}]))
}
export function base(manifest,packages,extra={}) {
 return {manifest:{name:'e2e-app',version:'1.0.0',private:true,...manifest},packages,targets:[target],advisories:[{name:target,range:'<6.0.10',id:10001}],...extra}
}
export function direct(field='dependencies',operator='^',name=target) {
 return base({[field]:{[name]:operator+'6.0.8'}},{[name]:versions(name)},{targets:[name],advisories:[{name,range:'<6.0.10',id:10001}]})
}
export function transitive(field='dependencies',operator='^',names={target,parent}) {
 const s=direct(field,'^',names.target)
 s.manifest[field]={[names.parent]:'^1.2.0'}
 s.packages[names.parent]={'1.2.4':{manifest:leaf(names.parent,'1.2.4',{dependencies:{[names.target]:operator+'6.0.8'}}),releasedAt:ago(20)},'1.3.0':{manifest:leaf(names.parent,'1.3.0',{dependencies:{[names.target]:'^7.0.0'}}),releasedAt:ago(20),seed:false}}
 return s
}
export function shared(exact=false) {
 const s=transitive();s.manifest.dependencies['e2e-parent-b']='^1.0.0'
 s.packages['e2e-parent-b']={'1.0.0':{manifest:leaf('e2e-parent-b','1.0.0',{dependencies:{[target]:exact?'6.0.9':'~6.0.8'}}),releasedAt:ago(20)}}
 return s
}
export function separate() {
 const s=shared(true);s.manifest.dependencies[target]='^7.0.0';return s
}
export function ancestor() {
 const s=transitive();s.manifest.dependencies={'e2e-ancestor':'^1.0.0'}
 s.packages['e2e-ancestor']={'1.0.0':{manifest:leaf('e2e-ancestor','1.0.0',{dependencies:{[parent]:'1.2.4'}}),releasedAt:ago(20)}}
 return s
}
export function sharedAncestry() {
 const s=transitive()
 s.manifest.dependencies={'e2e-layer-0-a':'1.0.0','e2e-layer-0-b':'1.0.0'}
 for(let level=0;level<11;level++) for(const side of ['a','b']) {
  const name=`e2e-layer-${level}-${side}`
  const dependencies=level===10?{[parent]:'1.2.4'}:{[`e2e-layer-${level+1}-a`]:'1.0.0',[`e2e-layer-${level+1}-b`]:'1.0.0'}
  s.packages[name]={'1.0.0':{manifest:leaf(name,'1.0.0',{dependencies}),releasedAt:ago(20)}}
 }
 return s
}
export function parentVersions() {
 const s=ancestor();s.manifest.dependencies['e2e-ancestor-b']='^1.0.0'
 s.packages['e2e-ancestor-b']={'1.0.0':{manifest:leaf('e2e-ancestor-b','1.0.0',{dependencies:{[parent]:'1.3.0'}}),releasedAt:ago(20)}}
 s.packages[parent]['1.3.0'].seed=true
 return s
}
export function repeated() {
 const s=separate();delete s.manifest.dependencies[parent];delete s.manifest.dependencies['e2e-parent-b']
 s.manifest.dependencies['e2e-ancestor-a']='1.0.0';s.manifest.dependencies['e2e-ancestor-b']='1.0.0'
 // Root parent at another major forces two physical copies of parent 1.2.4.
 s.manifest.dependencies[parent]='2.0.0'
 s.packages[parent]['2.0.0']={manifest:leaf(parent,'2.0.0'),releasedAt:ago(20)}
 for(const name of ['e2e-ancestor-a','e2e-ancestor-b']) s.packages[name]={'1.0.0':{manifest:leaf(name,'1.0.0',{dependencies:{[parent]:'1.2.4',...(name.endsWith('-b')?{[target]:'6.0.9'}:{})}}),releasedAt:ago(20)}}
 return s
}
export function existingOverride(conflict=false) {
 const s=transitive();s.packages['e2e-other']={'1.0.0':{manifest:leaf('e2e-other','1.0.0'),releasedAt:ago(20)}}
 s.packages[parent]['1.2.4'].manifest.dependencies['e2e-other']='^1.0.0'
 s.manifest.overrides={'e2e-unused':'^1.0.0',[parent+'@1.2.4']:{'.':'$'+parent,'e2e-other':'1.0.0',...(conflict?{[target]:'6.0.9'}:{})}}
 return s
}
export function supporting(twoCopies=false) {
 const s=twoCopies?separate():direct()
 for(const [v,p] of Object.entries(s.packages[target])) p.manifest.dependencies={'e2e-helper':(v==='6.0.9'||(twoCopies&&v.startsWith('7.')))?'^2.0.0':'^3.0.0'}
 s.packages['e2e-helper']={'2.0.5':{manifest:leaf('e2e-helper','2.0.5'),releasedAt:ago(20)},'3.0.2':{manifest:leaf('e2e-helper','3.0.2'),releasedAt:ago(20)}}
 if(twoCopies) {s.manifest.dependencies['e2e-unrelated']='^1.0.0';s.packages['e2e-unrelated']={'1.0.0':{manifest:leaf('e2e-unrelated','1.0.0'),releasedAt:ago(20)},'1.1.0':{manifest:leaf('e2e-unrelated','1.1.0'),releasedAt:ago(20),seed:false}}}
 return s
}
