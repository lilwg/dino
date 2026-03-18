-- Q*bert MAME Lua Bridge
-- mame qbert -rompath ~/mame/roms -autoboot_script /path/to/qbert-mame-bridge.lua -autoboot_delay 3

local bridge_dir = "/tmp/qbert-bridge"
local state_file = bridge_dir .. "/state.txt"
local cmd_file = bridge_dir .. "/cmd.txt"

os.execute("mkdir -p " .. bridge_dir)
local f = io.open(cmd_file, "w")
if f then f:write("NONE\n") f:close() end

-- Get CPU memory space
local cpu = manager.machine.devices[":maincpu"]
local mem = cpu.spaces["program"]

function read_byte(addr)
    return mem:read_u8(addr)
end

function dump_range(start, len)
    local bytes = {}
    for i = 0, len - 1 do
        bytes[i + 1] = string.format("%02x", read_byte(start + i))
    end
    return table.concat(bytes, " ")
end

-- Scan for non-zero RAM regions
local info_file = bridge_dir .. "/info.txt"
local fi = io.open(info_file, "w")
fi:write("=== RAM SCAN ===\n")
for base = 0x0000, 0xFFFF, 0x100 do
    local nonzero = 0
    for i = 0, 15 do
        if read_byte(base + i) ~= 0 then nonzero = nonzero + 1 end
    end
    if nonzero > 0 then
        fi:write(string.format("0x%04x: %s\n", base, dump_range(base, 32)))
    end
end
fi:close()
print("RAM scan written to " .. info_file)

-- Input control - use exact MAME field names from Q*bert
local ioports = manager.machine.ioport.ports
local input_fields = {}
for tag, port in pairs(ioports) do
    for fname, field in pairs(port.fields) do
        input_fields[fname] = field
    end
end

-- Q*bert specific field names (from MAME discovery):
-- "P1 Up (Up-Right)"       = UR on pyramid
-- "P1 Right (Down-Right)"  = DR on pyramid
-- "P1 Down (Down-Left)"    = DL on pyramid
-- "P1 Left (Up-Left)"      = UL on pyramid
-- "Coin 1"                 = insert coin
-- "1 Player Start"         = start game

function press_input(name)
    local field = input_fields[name]
    if field then
        field:set_value(1)
        print("PRESS: " .. name)
    else
        print("Unknown input: " .. name)
    end
end

function release_input(name)
    local field = input_fields[name]
    if field then
        field:clear_value()
    end
end

-- Frame state
local frame = 0
local pending_input = nil
local input_frames = 0

function write_state()
    local f = io.open(state_file, "w")
    if not f then return end
    f:write("FRAME=" .. frame .. "\n")
    -- Game state region
    f:write("RAM=" .. dump_range(0x0D00, 128) .. "\n")
    f:close()
end

function read_command()
    local f = io.open(cmd_file, "r")
    if not f then return "NONE" end
    local cmd = f:read("*l") or "NONE"
    f:close()
    f = io.open(cmd_file, "w")
    if f then f:write("NONE\n") f:close() end
    return cmd
end

function process_command(cmd)
    local field_map = {
        COIN  = "Coin 1",
        START = "1 Player Start",
        UL    = "P1 Left (Up-Left)",
        UR    = "P1 Up (Up-Right)",
        DR    = "P1 Right (Down-Right)",
        DL    = "P1 Down (Down-Left)",
    }
    local field_name = field_map[cmd]
    if field_name then
        press_input(field_name)
        input_frames = 12
        pending_input = field_name
        print("INPUT: " .. cmd .. " -> " .. field_name)
    end
end

function on_frame()
    frame = frame + 1
    if pending_input and input_frames > 0 then
        input_frames = input_frames - 1
        if input_frames <= 0 then
            release_input(pending_input)
            pending_input = nil
        end
    end
    if frame % 5 == 0 then write_state() end
    if frame % 3 == 0 then
        local cmd = read_command()
        if cmd ~= "NONE" then process_command(cmd) end
    end
end

emu.register_frame_done(on_frame, "frame")
print("=== Q*bert Bridge ready! ===")
