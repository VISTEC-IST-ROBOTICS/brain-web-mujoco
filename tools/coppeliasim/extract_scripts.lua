-- CoppeliaSim add-on script: load a scene and dump every embedded script's code.
-- Environment variables (set by extract_scripts.sh): SCENE_FILE, OUT_DIR
function sysCall_init()
    sim = require 'sim'
    local outDir = os.getenv('OUT_DIR')
    sim.loadScene(os.getenv('SCENE_FILE'))
    for _, h in ipairs(sim.getObjectsInTree(sim.handle_scene, sim.sceneobject_script, 0)) do
        local scene = os.getenv('SCENE_FILE'):match('([^/]+)%.ttt$')
        local name = scene .. '_' .. sim.getObjectAlias(h, 2):gsub('^/', ''):gsub('/', '_')
        local code = sim.getStringProperty(h, 'code')
        local path = string.format('%s/%s.lua', outDir, name)
        local f = assert(io.open(path, 'wb'))
        f:write(code)
        f:close()
        print('script written to ' .. path)
    end
    sim.quitSimulator()
end
