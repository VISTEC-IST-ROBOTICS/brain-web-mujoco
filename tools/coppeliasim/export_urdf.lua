-- CoppeliaSim add-on script: load a scene and export one model to URDF.
-- Configured through environment variables (set by export_urdf.sh):
--   SCENE_FILE  path to the .ttt scene
--   MODEL_PATH  scene path of the model root, e.g. /body_carbon_rod
--   URDF_FILE   output .urdf path (meshes are written next to it)
--   URDF_OPTS   simURDF.export options bitmask (default 0)
function sysCall_init()
    sim = require 'sim'
    simURDF = require 'simURDF'

    local scene = os.getenv('SCENE_FILE')
    local modelPath = os.getenv('MODEL_PATH')
    local out = os.getenv('URDF_FILE')
    local opts = tonumber(os.getenv('URDF_OPTS') or '0')

    sim.loadScene(scene)
    local h = sim.getObject(modelPath)
    -- the exporter copies the object as a model, so the root must be flagged as one
    sim.setModelProperty(h, 0)
    sim.setObjectProperty(h, sim.getObjectProperty(h) | sim.objectproperty_collapsed | sim.objectproperty_selectmodelbaseinstead)
    -- simURDF only handles the first child shape of a joint and only finds joints that are
    -- direct children of it. Flatten each link: every shape/joint/force sensor hanging off
    -- the link's other shapes is reparented (pose kept) onto the link's first shape.
    local function isShape(o) return sim.getObjectType(o) == sim.sceneobject_shape end
    local function isJoint(o)
        local t = sim.getObjectType(o)
        return t == sim.sceneobject_joint or t == sim.sceneobject_forcesensor
    end
    local joints = {}
    for _, o in ipairs(sim.getObjectsInTree(h, sim.handle_all, 0)) do
        if isJoint(o) then joints[#joints + 1] = o end
    end
    for _, j in ipairs(joints) do
        local link = sim.getObjectChild(j, 0)
        if link ~= -1 and isShape(link) then
            local queue = {}
            for _, c in ipairs(sim.getObjectsInTree(j, sim.handle_all, 1 | 2)) do
                if c ~= link and isShape(c) then queue[#queue + 1] = c end
            end
            table.insert(queue, 1, link)
            local qi = 1
            while qi <= #queue do
                local o = queue[qi]
                qi = qi + 1
                for _, c in ipairs(sim.getObjectsInTree(o, sim.handle_all, 1 | 2)) do
                    if isShape(c) then queue[#queue + 1] = c end
                    if o ~= link and (isShape(c) or isJoint(c)) then
                        sim.setObjectParent(c, link, true)
                    end
                end
            end
            for _, c in ipairs(sim.getObjectsInTree(j, sim.handle_all, 1 | 2)) do
                if c ~= link and isShape(c) then sim.setObjectParent(c, link, true) end
            end
        end
    end
    local ok, err = pcall(simURDF.export, h, out, opts)
    if ok then
        print('URDF exported to ' .. out)
    else
        print('URDF export failed: ' .. tostring(err))
    end
    sim.quitSimulator()
end
