//Script for setup a demosetup of single blade with autodetected IO-Boards for a Easy IP Router Demo.
//This script checks if the at300 FPGA "AVP" is loaded, set the ptp of FreeRun and dected wish io-module is connected.
//This Should work in a Standalone Version or with a switch.
//For Multicast Adresses the vutil function "stream video" is used - this used the scheme of
//the rear management address to create mcast - addresses.

//To do:
// PTP DOMAIN AM ENDE ENTFERNEN UND AUF DEFAULT 127 gehen.
// PRO SDI INPUT SRCs AUFSETZEN - Done
// 16x Videoplayer with internal videoclips
// PRO SDI INPUT VIDEO/AUDIO TRANSMITTER AUFSETZEN - done
// PRO SDI OUTPUT VIDEO/AUDIO RECEIVER AUFSETZEN - done
// PRO SDI INPUT / OUTPUT AUDIOSHUFFLER AUFSETZEN - done
// Naming of Transmitter - done 
// Restart Ember - done

import * as VAPI from "vapi";
import {
  asyncIter,
  asyncZip,
  Duration,
  enforce,
  enforce_nonnull,
  pause,
} from "vscript";
import { setup_ptp } from "vutil/ptp.js";
import { audio_ref, scrub, video_ref } from "vutil";
import { stream_audio, stream_video } from "vutil/rtp_transmitter";
import {
  create_audio_receiver,
  create_video_receiver,
} from "vutil/rtp_receiver";
import * as FS from "fs";
import { z } from 'zod';
import * as path from 'path';
import { encode_biw, load_wave, upload, wave_file_to_biw } from "vutil/biw-utils";

namespace AUDIO_PLAYER{
const dirPath = '/media/sda1/clips_audio';


async function parseWaveFilesInDirectory(dirPath: string): Promise<string[]> {
  try {
    const absoluteDirPath = path.resolve(dirPath);
    const dirStat = await FS.promises.stat(absoluteDirPath);

    if (!dirStat.isDirectory()) {
      throw new Error(`Directory ${dirPath} does not exist or is not a directory`);
    }

    const files = await FS.promises.readdir(absoluteDirPath);
    const wavFiles = files.filter(file => path.extname(file).toLowerCase() === '.wav');

    const results:string[] = []
    const parsePromises = wavFiles.map(async (file) => {
      const filePath = path.join(absoluteDirPath, file);
      const fileStat = await FS.promises.stat(filePath);
      if (fileStat.isFile()) {
        results.push(filePath);
      }
    });
    await Promise.all(parsePromises);
    return results;
  } catch (e) {
    throw new Error(`Failed to parse .wav files: ${e.message}`);
  }
}

async function doCreatePlayer(vm:VAPI.AT1130.Root, filename:string){
    enforce(!!vm.re_play)
    try {
        const prev_free_mem = await vm.re_play.audio.info.free.read()
        const wav = load_wave(filename);
        const biw = wave_file_to_biw(wav);
        const as_buffer = encode_biw(biw);
        const n = `player-${path.basename(filename).split(".")[0]}`.substring(0, 31);
        const player = await vm.re_play.audio.players.create_row({ name: n });
        await player.capabilities.num_channels.command.write(
        16 * Math.ceil(biw.header.Channels / 16),
        );
        await player.capabilities.frequency.command.write("F48000");
        await player.capabilities.capacity.command.write({
        variant: "Samples",
        value: { samples: biw.header.SamplesPerChannel },
        });
        const url = `http://${vm.raw.ip}/replay/audio?action=write&handler=${player.index}&store=clip_single_file`;
        await upload(url, as_buffer);
        await player.output.control.stop.write("Click");
        await player.output.control.play_mode.command.write("Loop");
        await player.output.control.play.write("Click");
    } catch(e) {
        throw new Error(`Failed to upload ${filename} files: ${e.message}`);
    }
}
export async function setup_audio_player(vm: VAPI.AT1130.Root){
  try {
    const dirStat = await FS.promises.stat(dirPath).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new Error(`Directory ${dirPath} does not exist or is not accessible`);
    }
    const results = await parseWaveFilesInDirectory(dirPath);


    console.log("Parsed .wav Files:");
    await vm.re_play?.audio.players.delete_all()
    for (const fileName of results) {
      console.log(`\nFile: ${fileName}`);
      await doCreatePlayer(vm,fileName)
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      console.warn(`Directory or file access issue: ${dirPath}`);
    }
  } finally {
  }



}
}

namespace VID_PLAYER{


const headerSchema = z.object({
  Date: z.string().min(1),
  Time: z.string().min(1),
  Interlace: z.boolean(),
  Blanking: z.boolean(),
  Hostname: z.string().min(1),
  Frames: z.number().int().min(0),
  HTotal: z.number().int().positive(),
  VTotal: z.number().int().positive(),
  HActive: z.number().int().positive(),
  VActive: z.number().int().positive(),
  Standard: z.string().min(1),
  TC: z.enum(["SDR", "HLG", "PQ"]).optional(),
  ColorSpace: z.string().min(1).optional(),
});



type HeaderData = z.infer<typeof headerSchema>;
type ParseResult = { header: HeaderData; binary: Buffer; rest: Buffer };
//const dirPath = '/media/sda1/ip_ready_router_clips';
const dirPath = '/media/sda1/ip_ready_router_clips';

// Function to parse header from a file
function parseHeaderFromStream(filePath: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    let jsonData = '';
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;
    const readStream = FS.createReadStream(filePath, { highWaterMark: 512 }); // 512 bytes per chunk

    readStream.on('data', (chunk: Buffer) => {
      totalBytesRead += chunk.length;
      chunks.push(chunk); // Collect all chunks for binary data

      if (totalBytesRead > 1000) {
        readStream.close();
        reject(new Error(`Header exceeds 1000 bytes in ${path.basename(filePath)}`));
        return;
      }

      const chunkString = chunk.toString('utf8');
      jsonData += chunkString;

      // Check if the file starts with '{'
      if (totalBytesRead === chunk.length && !jsonData.startsWith('{')) {
        readStream.close();
        reject(new Error(`File ${path.basename(filePath)} does not start with '{'`));
        return;
      }

      const braceIndex = jsonData.indexOf('}');
      if (braceIndex !== -1) {
        // Found the end of JSON within 1000 bytes
        const jsonPart = jsonData.slice(0, braceIndex + 1).trim();
        try {
          const header = headerSchema.parse(JSON.parse(jsonPart));
          const totalLength = Buffer.concat(chunks).length;
          const jsonLength = Buffer.byteLength(jsonPart, 'utf8');
          const binaryBuffer = Buffer.from(Buffer.concat(chunks).subarray(jsonLength, Math.min(totalLength, 1000))); // Limit to 1000 bytes
          readStream.close();

          resolve({
            header,
            binary: binaryBuffer,
            rest: Buffer.alloc(0), // Rest is not read beyond 1000 bytes
          });
        } catch (e) {
          reject(new Error(`Failed to parse JSON in ${path.basename(filePath)}: ${e.message}`));
        }
      }
    });

    readStream.on('error', (e) => {
      reject(new Error(`Stream error for ${path.basename(filePath)}: ${e.message}`));
    });

    readStream.on('end', () => {
      if (totalBytesRead <= 1000 && jsonData.indexOf('}') === -1) {
        reject(new Error(`No closing brace '}' found within 1000 bytes in ${path.basename(filePath)}`));
      }
    });
  });
}

async function parseBidFilesInDirectory(dirPath: string): Promise<{ [fileName: string]: ParseResult }> {
  try {
    const absoluteDirPath = path.resolve(dirPath);
    const dirStat = await FS.promises.stat(absoluteDirPath);

    if (!dirStat.isDirectory()) {
      throw new Error(`Directory ${dirPath} does not exist or is not a directory`);
    }

    const files = await FS.promises.readdir(absoluteDirPath);
    const bidFiles = files.filter(file => path.extname(file).toLowerCase() === '.bid');
    const results: { [fileName: string]: ParseResult } = {};

    const parsePromises = bidFiles.map(async (file) => {
      const filePath = path.join(absoluteDirPath, file);
      const fileStat = await FS.promises.stat(filePath);
      if (fileStat.isFile()) {
        const result = await parseHeaderFromStream(filePath);
        results[file] = result;
      }
    });
    await Promise.all(parsePromises);

    return results;
  } catch (e) {
    throw new Error(`Failed to parse .bid files: ${e.message}`);
  }
}

async function doCreatePlayer(vm:VAPI.AT1130.Root, header:HeaderData, filename:string){
     enforce(!!vm.re_play)
    try {
        const prev_free_mem = await vm.re_play.video.info.free.read()
        const player = await vm.re_play.video.players.create_row()
        await player.capabilities.command.write({capacity:{variant:"Frames", value:{frames:header.Frames}}, 
                            input_caliber:{add_blanking:header.Blanking, constraints:{variant:"Standard", value:{standard:header.Standard as VAPI.Video.Standard}}}})
        await pause(new Duration(1,'s'))
        const new_free_mem = await vm.re_play.video.info.free.read()
        if(prev_free_mem.as_bytes === new_free_mem.as_bytes){
        throw new Error(`Not enough memory to load the clip ${filename}`);
        }
        await player.upload.load.file.command.write(`${dirPath}/${filename}`)
        console.log(`${dirPath}/${filename}`)
        await player.upload.load.load.write("Click")
    //     await player.upload.load.progress.wait_until((val) => {
    //         console.log(val)
    //         return val === 100
    // },)
    } catch(e) {
        throw new Error(`Failed to upload ${filename} files: ${e.message}`);
    }
}

export async function setup_video_player(vm: VAPI.AT1130.Root){
  try {
    const dirStat = await FS.promises.stat(dirPath).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      throw new Error(`Directory ${dirPath} does not exist or is not accessible`);
    }
    const results = await parseBidFilesInDirectory(dirPath);
    console.log("Parsed .bid Files:");
    await vm.re_play?.video.players.delete_all()
    for (const [fileName, result] of Object.entries(results)) {
      console.log(`\nFile: ${fileName}`);
      console.log("Header:", result.header);
    //   console.log("Binary Data (hex):", result.binary.toString('hex'));
    //   console.log("Remaining Data (hex):", result.rest.length > 0 ? result.rest.toString('hex') : "None");
      await doCreatePlayer(vm,result.header,fileName)
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      console.warn(`Directory or file access issue: ${dirPath}`);
    }
  } finally {
  }
}


}





const vm = await VAPI.VM.open({});
enforce(vm instanceof VAPI.AT1130.Root);
enforce(
  !!vm.i_o_module &&
    !!vm.genlock &&
    !!vm.video_signal_generator &&
    !!vm.sample_rate_converter
);

//setup general_config.json file for ember
async function checkup_ember() {
  if (FS.existsSync("/config/ember/config_general_16.json")) {
    FS.copyFileSync(
      "/config/ember/config_general_16.json",
      "/config/ember/config_general.json"
    );
  } else {
    process.exit(`no /config/ember/`);
  }
}

//Setup Videosignalgenerator
async function setup_vsg(vm: VAPI.AT1130.Root) {
  enforce(!!vm.video_signal_generator && !!vm.genlock);
  console.log(`setting up videosignalgenerator`);
  await vm.video_signal_generator.instances
    .row(0)
    .t_src.command.write(vm.genlock.instances.row(0).backend.output);
  await vm.video_signal_generator.instances
    .row(0)
    .standard.command.write("HD1080p59_94");
}

//Read out io-module variant
async function setup_io_module(vm: VAPI.AT1130.Root) {
  try {
    enforce(!!vm.i_o_module && !!vm.genlock && !!vm.video_signal_generator);
    const io_module_version = await vm.system.io_board.info.type.read();
    console.log(`io-module version: ${io_module_version}`);

    if (
      io_module_version == "IO_BNC_16bidi" ||
      io_module_version == "IO_BNC_16bidi_GD32" ||
      io_module_version == "IO_MSC_v2" ||
      io_module_version == "IO_MSC_v2_GD32"
    ) {
      const config_bnc_input =
        (await vm.i_o_module.configuration.rows()).length / 2;
      console.log(`number of sid inputs: ${config_bnc_input}`);
      for (let i = 0; i < config_bnc_input; i++) {
        await vm.i_o_module.configuration.row(i).direction.write("Input");
        await vm.i_o_module.configuration
          .row(i + config_bnc_input)
          .direction.write("Output");
      }
    } else {
      console.log(
        `io-module with fixed sid directions connected: ${io_module_version}`
      );
    }
    const all_sdi_outs = await vm.i_o_module.output.rows();
    for (const settings of all_sdi_outs) {
      await settings.sdi.t_src.command.write(
        vm.genlock.instances.row(0).backend.output
      );
      await settings.sdi.v_src.command.write({
        source: vm.video_signal_generator.instances.row(0).output,
        switch_time: null,
      });
      await settings.sdi.embedded_audio.command.write([
        "Embed",
        "Embed",
        "Embed",
        "Embed",
        "Off",
        "Off",
        "Off",
        "Off",
      ]);
    }
    const all_sdi_inputs = await vm.i_o_module.input.rows();
    for (const settings of all_sdi_inputs) {
      await settings.audio_timing.command.write({
        variant: "Asynchronous",
        value: { frequency: "F48000" },
      });
    }
  } catch (e) {
    console.log(e, "no io-board detected");
  }
  console.log(`finishd setup sdi io-board`);
}

//Function to setup samplerate_converter
async function setup_samplerate_converter(vm: VAPI.AT1130.Root) {
  try {
    //setting up srcs
    console.log(`setting up audio srcs`);
    enforce(!!vm.i_o_module && !!vm.sample_rate_converter);

    await asyncIter(await vm.i_o_module.input.rows(), async (_, i) => {
      enforce(
        !!vm.sample_rate_converter &&
          !!vm.genlock &&
          !!vm.i_o_module &&
          !!vm.audio_shuffler
      );
      const gen = vm.genlock.instances.row(0).backend.output;
      const src = await vm.sample_rate_converter.instances.create_row();
      await src.settings.t_src.command.write(gen);
      await src.settings.channel_capacity.command.write(16);
      await src.a_src.command.write(
        vm.i_o_module.input.row(i).sdi.output.audio
      );
      await src.active.command.write(true);
    });
    const number_srcs = (await vm.sample_rate_converter.instances.rows())
      .length;
    console.log(`number of samplerate converter: ${number_srcs}`);
  } catch (e) {
    console.log(`error while setting up src: ${e}`);
  }
}

//Function to setup Input Audioshuffler
async function setup_input_audio_shuffler(vm: VAPI.AT1130.Root) {
  enforce(!!vm.sample_rate_converter);
  const number_srcs = (await vm.sample_rate_converter.instances.rows()).length;
  await asyncIter(new Array<number>(number_srcs), async (_, i) => {
    enforce(!!vm.sample_rate_converter && !!vm.genlock && !!vm.audio_shuffler);
    const audio_shuffler = await vm.audio_shuffler.instances.create_row();
    await audio_shuffler.genlock.command.write(vm.genlock.instances.row(0));
    let update: any = {};
    for (let index = 0; index < 16; index++) {
      update[index] = vm.sample_rate_converter.instances
        .row(i)
        .output.channels.reference_to_index(index);
    }
    await audio_shuffler.a_src.command.write(update);
  });
}

//Load Clips from USB Stick
//Hier entsteht bestimmt noch super Code

//Setup Transmitters
async function setup_video_audio_transmitters(vm: VAPI.AT1130.Root) {
  enforce(
    !!vm.audio_shuffler &&
      !!vm.i_o_module &&
      !!vm.re_play &&
      !!vm.video_signal_generator &&
      !!vm.audio_signal_generator
  );
  enforce(!!vm.r_t_p_transmitter);
  const videosource_vsg = vm.video_signal_generator.instances.row(0).output;
  const audiosource =
    vm.audio_signal_generator.genlock.row(0).f48000.signal_1000hz.output;
  const audio_shuffler = await vm.audio_shuffler.instances.rows();

  const sdi_inputs = await vm.i_o_module.input.rows();
  console.log(`number of sdi inputs: ${sdi_inputs.length}`);

  await asyncIter(sdi_inputs, async () => {
    await stream_video(videosource_vsg);
  });

  await asyncIter(sdi_inputs, async () => {
    await stream_audio(audiosource,{format:{format:"L24", num_channels:16, packet_time:"p0_125"}});
  });

  const txs_v = await vm.r_t_p_transmitter.video_transmitters.rows();
  const txs_a = await vm.r_t_p_transmitter.audio_transmitters.rows();
  await asyncZip(txs_v, txs_a, async (tx_v, tx_a) => {
    const sess_v = enforce_nonnull(
      await tx_v.generic.hosting_session.status.read()
    );
    const sess_a = enforce_nonnull(
      await tx_a.generic.hosting_session.status.read()
    );
    await sess_a.active.command.write(false);
    await sess_v.active.command.write(false);
    await tx_a.generic.hosting_session.command.write(sess_v);
    await sess_v.active.command.write(true);
  });
  await asyncIter(await vm.r_t_p_transmitter.sessions.rows(), async (sess) => {
    if ((await sess.active.status.read()) === false) sess.delete();
  });

  const sessions = await vm.r_t_p_transmitter.sessions.rows()
  await asyncZip(sdi_inputs, txs_v, async (inp, tx, idx) => {
    enforce(!!vm.re_play)
    const src = await inp.sdi.hw_status.standard.read();
    const players = await vm.re_play.video.players.rows();
    if(players.length > 0){
      await tx.v_src.command.write(video_ref(players[idx%players.length].output.video));
    }
    if(src !== null)
      await tx.v_src.command.write(video_ref(inp.sdi.output.video)
    );
    const name = `${src === null ? "VSG":"SDI"}_${idx}`
    await tx.rename(name);
    if(idx < sessions.length) sessions[idx].rename(name);
  });
  await asyncZip(sdi_inputs, txs_a, async (inp, tx, idx) => {
    const src = await inp.sdi.hw_status.standard.read();
    tx.a_src.command.write(
      audio_ref(
        src === null
          ? audiosource
          : idx < audio_shuffler.length
          ? audio_shuffler[idx].output
          : audiosource
      )
    );
    const name = `${src === null
          ? "ASG"
          : idx < audio_shuffler.length
          ? "A_Shuffler"
          : "ASG"}_${idx}`
    await tx.rename(name);
  });
}
//Setup Receiver
async function setup_video_audio_receiver(vm: VAPI.AT1130.Root) {
  enforce(!!vm.r_t_p_receiver && !!vm.i_o_module && !!vm.genlock);

  const sdi_outputs = await vm.i_o_module.output.rows();
  console.log(`number of sdi outputs: ${sdi_outputs.length}`);

  for(let index=0; index < sdi_outputs.length; index++){
    const rx = await create_video_receiver(vm, {
      st2110_20_caliber: "ST2110_upto_3G",
      read_speed: {
        variant: "LockToGenlock",
        value: { genlock: vm.genlock?.instances.row(0) },
      },
      supports_clean_switching: true,
      supports_uhd_sample_interleaved: false,
      supports_2022_6: false,
      supports_2110_40: true,
      jpeg_xs_caliber: null,
      st2042_2_caliber: null,
    });
    await rx.rename(`SDI_OUT_${index}`)
  };
  for(let index=0; index < sdi_outputs.length; index++){
    const rx = await create_audio_receiver(vm, {
      channel_capacity: 16,
      supports_clean_switching: true,
      payload_limit: "AtMost960Bytes",
      read_speed: {
        variant: "LockToGenlock",
        value: { genlock: vm.genlock?.instances.row(0) },
      },
    });
    await rx.rename(`SDI_OUT_A_${index}`)
  };
  const rxs_v = await vm.r_t_p_receiver.video_receivers.rows();
  const rxs_a = await vm.r_t_p_receiver.audio_receivers.rows();
  await asyncZip(rxs_v, rxs_a, async (rx_v, rx_a) => {
    const sess_v = enforce_nonnull(
      await rx_v.generic.hosting_session.status.read()
    );
    const sess_a = enforce_nonnull(
      await rx_a.generic.hosting_session.status.read()
    );
    await sess_a.active.command.write(false);
    await sess_v.active.command.write(false);
    await rx_a.generic.hosting_session.command.write(sess_v);
    await rx_a.generic.timing.target.command.write({
      variant: "ForeignReadDelay",
      value: {
        foreign_receiver: rx_v.generic,
        extra_delay: new Duration(0, "s"),
        on_backpressure: "Yield",
      },
    });
    await sess_v.active.command.write(true);
  });
  await asyncIter(await vm.r_t_p_receiver.sessions.rows(), async (sess) => {
    if ((await sess.active.status.read()) === false) sess.delete();
  });
  // await asyncIter(await vm.r_t_p_receiver.sessions.rows(), async (sess, index) => {
  //   await sess.rename(`SDI_OUT_${index}`)
  // });
}



async function patch_rx_audio_video_to_sdi_out(vm: VAPI.AT1130.Root) {
  enforce(!!vm.i_o_module && !!vm.r_t_p_receiver);
  const rxs_v = await vm.r_t_p_receiver.video_receivers.rows();
  const rxs_a = await vm.r_t_p_receiver.audio_receivers.rows();
  const sdi_o = await vm.i_o_module.output.rows();
  await asyncZip(rxs_v, sdi_o, async (rx_v, io) => {
    await io.sdi.v_src.command.write(
      video_ref(rx_v.media_specific.output.video)
    );
  });
  await asyncZip(rxs_a, sdi_o, async (rx_a, io) => {
    await io.a_src.command.write(audio_ref(rx_a.media_specific.output.audio));
  });
  console.log(`finished setting up rxs as sources for sdi outputs`);
}

//Function to restart Ember
async function restart_ember(vm: VAPI.AT1130.Root) {
  await vm.system.services.ember.command.write(false);
  const pause_break = new Duration(1, "s");
  await pause(pause_break);
  await vm.system.services.ember.command.write(true);
}

//SETUP STARTS HERE
//Scrub AT300
await scrub(vm);
await checkup_ember();
//PTP Setup to FreeRunMaster
console.log("start setting up PTP Clock as FreeRun Master");
await setup_ptp(vm, {
  mode: "FreerunMaster",
  await_calibration: true,
  vlan: 0,
  ptp_domain: 123,
});
console.log("finished setting up ptp");
await setup_vsg(vm);
await setup_io_module(vm);
await VID_PLAYER.setup_video_player(vm)
await AUDIO_PLAYER.setup_audio_player(vm)
await setup_samplerate_converter(vm);
await setup_input_audio_shuffler(vm);
await setup_video_audio_transmitters(vm);
await setup_video_audio_receiver(vm);
await patch_rx_audio_video_to_sdi_out(vm);
await restart_ember(vm);
await vm.close();

console.log("finished setting up 16x16 IP-READY ROUTER Demosetup");
