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
