'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');

// Performance references keep their original Relay names and signed bytes.
// Resolve executable names from the bundle instead of changing those archives.
function appBundle(app){
  const nativeName=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();
  if(!nativeName||path.basename(nativeName)!==nativeName)throw Error('Invalid native bundle executable');
  const native='Contents/MacOS/'+nativeName;
  const host=['Contents/Resources/nimlo-editor','Contents/Resources/relay-editor'].find(name=>fs.existsSync(path.join(app,name)));
  if(!host)throw Error('Bundle is missing its editor host');
  return {native,host};
}
module.exports={appBundle};
