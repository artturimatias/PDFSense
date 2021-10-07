
const axios 		= require('axios');
var fs 				= require('fs');
var fsp 			= require('fs').promises;
const util 			= require('util');
const stream 		= require('stream')
const path			= require('path')
const sharp 		= require('sharp');
const {v1:uuid} 	= require('uuid');
const { Poppler } 	= require("node-poppler");


const finished = util.promisify(stream.finished);

const ROOT = 'data'

class PDFSense {

	constructor(config) {
		this.config = config
	}


	async extractImagesFromPDF(file_id, options) {
		var filename = this.getFilenameFromFileID(file_id)
		const input_path = path.join(ROOT, file_id)
		const output_path = 'extracted/images'
		const filepath = path.join(input_path, filename)
		if(!await this.exists(filepath)) throw('Upload path not found!')
		await fsp.mkdir(path.join(input_path, output_path), { recursive: true })
		await this.PDFImages(filepath, path.join(input_path, output_path))
		var files = await this.getFileList(path.join(input_path, output_path), '')
		var response = {files: files}
		return response
	}

	async extractTextFromPDF(file_id, options) {
		var filename = this.getFilenameFromFileID(file_id)
		const input_path = path.join(ROOT, file_id)
		const output_path = 'extracted/text'
		const filepath = path.join(input_path, filename)
		if(!await this.exists(filepath)) throw(`Upload path not found! file: ${file_id}`)
		await fsp.mkdir(path.join(input_path, output_path), { recursive: true })
		await this.PDFToText(filepath, path.join(input_path, output_path))
		var files = await fsp.readdir(path.join(input_path, output_path))
		var response = {files: files}
		return response
	}

	async renderImagesFromPDF(params, options, query) {
		if(!params.resolution || !parseInt(params.resolution)) throw('Invalid render resolution (must be integer)')

		options.resolutionXYAxis = parseInt(params.resolution)
		if(query.format && ['jpg', 'jpeg'].includes(query.format)) options.jpegFile = true
		else options.pngFile = true
		if(!options.cropBox) options.cropBox = true

		var filename = this.getFilenameFromFileID(params.fileid)
		const input_path = path.join(ROOT, params.fileid)
		const output_path = 'rendered/' + options.resolutionXYAxis
		const filepath = path.join(input_path, filename)
		if(!await this.exists(filepath)) throw('Upload path not found!')
		await fsp.mkdir(path.join(input_path, output_path), { recursive: true })

		//await this.PDFToPpm(filepath, path.join(input_path, output_path), options)
		const poppler = new Poppler('/usr/bin/');
		await poppler.pdfToPpm(filepath, path.join(input_path, output_path) + '/page', options);
		var files = await this.getFileList(path.join(input_path, output_path), '')
		var response = {files: files}
		return response
	}

	async sharp(params, options, url_path, query) {
		const file_id = params.fileid
		const command_path = `/sharp/${params.sharp_command}`
		var p = url_path.split(file_id)[1]
		const input_path = path.join(ROOT, file_id, p.replace(command_path,''))
		const out_path =  path.join(ROOT, file_id, p)
		var files = await this.getFileList(input_path, '')
		await fsp.mkdir(out_path, { recursive: true })
		var angle = 90
		if(query.angle) {
			angle = parseInt(query.angle)
		}
		for(const f of files) {
			console.log(f)
			await sharp(path.join(input_path, f)).rotate(angle).toFile(path.join(out_path, f))

		}

	}

	async tesseract(params, options, url_path, query) {
		const file_id = params.fileid
		const command_path = `/tesseract/${params.tesseract_command}`
		console.log(command_path)
		var p = url_path.split(file_id)[1]
		const input_path = path.join(ROOT, file_id, p.replace(command_path,''))
		const out_path =  path.join(ROOT, file_id, p)
		var files = await this.getFileList(input_path, input_path)
		if(query.lang) {
			options.lang = query.lang
		}
		console.log(`tesseract options: ${JSON.stringify(options, null, 2)}`)
		if(params.tesseract_command === 'pdf') {
			 await this.tesseractToPDF(files, options, out_path)
		} else if(params.tesseract_command === 'textpdf') {
			if(!options.c) options.c = {}
			options.c['textonly_pdf'] = 1
			await this.tesseractToPDF(files, options, out_path)
		} else {
			await this.tesseractToTextFile(files, options, out_path)
		}
	}

	async tesseractToTextFile(filelist, options, out_path) {
		await fsp.mkdir(out_path, { recursive: true })
		const tesseract = require("node-tesseract-ocr")
		let result = []
		for(const f of filelist) {
			const used = process.memoryUsage().heapUsed / 1024 / 1024;
			console.log(`The script uses approximately ${Math.round(used * 100) / 100} MB`);
			console.log('processing ' + f)
			const text = await tesseract.recognize(f, options)
			await fsp.writeFile(path.join(out_path, path.basename(f) + '.txt'), text, 'utf8')
			result.push(text)
		}
		// create fulltext.txt
		result = result.map((x , index) => '\n\n--- ' + index + ' ---\n\n' + x )
		await fsp.writeFile(path.join(out_path, 'fulltext.txt'), result.join(''), 'utf8')
		return 'done'
	}

	async tesseractToPDF(filelist, options, out_path) {
		await fsp.mkdir(out_path, { recursive: true })
		await fsp.writeFile(path.join(out_path, 'files.txt'), filelist.join('\n'), 'utf8')
		var result = await this.tesseract_spawn(filelist, options, out_path)
		await fsp.writeFile(path.join(out_path, 'ocr.cli'), result.cli.join(' '), 'utf8')
		await fsp.writeFile(path.join(out_path, 'ocr.log'), result.log.join('\n'), 'utf8')

		return 'done'
	}

	tesseract_spawn(filelist, options, out_path) {
		const spawn = require("child_process").spawn
		var args = []
		if(options.c) {
			for(var parameter in options.c) {
				args.push('-c')
				args.push(`${parameter}=${options.c[parameter]}`)
			}
		}
		args.push(path.join(out_path, 'files.txt'))
		args.push(path.join(out_path, 'ocr'))
		args.push('pdf')
		var result = {log: [], cli: '', exitcode: ''}
		//var id = this.getFilenameFromFileID()
		 return new Promise((resolve, reject) => {
			 var child = spawn('tesseract', args);
			 console.log(child.spawnargs)
			 result.cli = child.spawnargs

			child.stdout.setEncoding('utf8');
	 		child.stdout.on('data', function (data) {
	 			console.log('stdout: ' + data);
	 		});
			child.stderr.setEncoding('utf8');
	 		child.stderr.on('data', function (data) {
	 			console.log('stderr: ' + data);
				result.log.push(data)
	 		});
	 		child.on('close', function (code) {
	 			console.log('child process exited with code ' + code);
				result.log.push(code)
				result.exitcode = code
				resolve(result)
	 			//file.end();
	 		});
			child.on('error', function (code) {
	 			console.log('child process errored with code ' + code);
				result.exitcode = code
				reject(result)
	 			//file.end();
	 		});
		 })
	}


	async noteshrink(params, options, url_path, query) {
		const file_id = params.fileid
		const command_path = `/noteshrink/${params.noteshrink_command}`
		console.log(command_path)
		var p = url_path.split(file_id)[1]
		const input_path = path.join(ROOT, file_id, p.replace(command_path,''))
		console.log(input_path)
		const out_path =  path.join(ROOT, file_id, p)
		await fsp.mkdir(out_path, { recursive: true })
		var filelist = await this.getFileList(input_path, input_path)
		await fsp.writeFile(path.join(out_path, 'files.txt'), filelist.join('\n'), 'utf8')
		var result = {log: [], cli: []}

		for(const file of filelist) {
			try {
				var outfile = path.basename(file).split('.').slice(0, -1).join('.')
				var args = ['noteshrink/noteshrink.py', '-b'+out_path+'/'+outfile, file]
				var out = await this.spawn('python3', args)
				result.cli.push(out.cli)
				result.log.push(out.log)
			} catch(e) {
				console.log(`Problem with file ${file} \n ${e}`)
			}
		}

		await fsp.writeFile(path.join(out_path, 'noteshrink.cli'), result.cli.join('\n'), 'utf8')
		await fsp.writeFile(path.join(out_path, 'noteshrink.log'), result.log.join('\n'), 'utf8')
		return result
	}

	async combinePDFs(params, options, url_path, query) {
		const file_id = params.fileid
		const command_path = `/combined`
		var p = url_path.split(file_id)[1]
		const input_path = path.join(ROOT, file_id, p.replace(command_path,''))
		const out_path =  path.join(ROOT, file_id, p)
		await fsp.mkdir(out_path, { recursive: true })
		//var dirs = await this.getDirList('./')
		//console.log(dirs)
		// find out where textonly PDF is (ocr.pdf)
		var dirs = []
		for await (const f of this.getTextPdfDirs(path.join(ROOT, file_id))) {
  			console.log(f);
			dirs.push(f)
		}
		console.log(dirs)
		var result = {}
		if(dirs.length > 0) {
			var args = ['--empty', '--pages', input_path + '/images.pdf', '--', '--underlay',dirs[dirs.length-1] + '/ocr.pdf','--',out_path + '/full.pdf']
			result = await this.spawn('qpdf', args)
			result.used_textonlypdf = dirs[dirs.length-1]
			if(dirs.length > 1) {
				result.textonlypdf_dirs = dirs
				//result.hint = "You can select textonlypdf by parameter 'textonly=[ARRAY INDEX]'"
			}
		}
		await fsp.writeFile(path.join(out_path, 'qpdf.cli'), result.cli, 'utf8')
		await fsp.writeFile(path.join(out_path, 'qpdf.log'), result.log.join('\n'), 'utf8')
		return result

	}

	async images2PDF(params, options, url_path, query) {
		const file_id = params.fileid
		const command_path = `/pdf`
		var p = url_path.split(file_id)[1]
		const input_path = path.join(ROOT, file_id, p.replace(command_path,''))
		console.log(input_path)
		const out_path =  path.join(ROOT, file_id, p)
		await fsp.mkdir(out_path, { recursive: true })
		var filelist = await this.getFileList(input_path, input_path)
		await fsp.writeFile(path.join(out_path, 'files.txt'), filelist, 'utf8')
		filelist.push('-o')
		filelist.push(out_path + '/images.pdf')
		var result = await this.spawn('img2pdf', filelist)
		await fsp.writeFile(path.join(out_path, 'convert.cli'), result.cli, 'utf8')
		await fsp.writeFile(path.join(out_path, 'convert.log'), result.log.join('\n'), 'utf8')
		return result
	}

	spawn(command, args) {
		const spawn = require("child_process").spawn
		var result = {log: [], cli: '', exitcode: ''}

		 return new Promise((resolve, reject) => {
			var child = spawn(command, args);
			console.log(child.spawnargs)
			result.cli = child.spawnargs.join(' ')

			child.stdout.setEncoding('utf8');
	 		child.stdout.on('data', function (data) {
	 			console.log('stdout: ' + data);
				result.log.push(data)
	 		});
			child.stderr.setEncoding('utf8');
	 		child.stderr.on('data', function (data) {
	 			console.log('stderr: ' + data);
				result.log.push(data)
	 		});
	 		child.on('close', function (code) {
	 			console.log('child process exited with code ' + code);
				result.log.push(code)
				result.exitcode = code
				resolve(result)
	 			//file.end();
	 		});
			child.on('error', function (code) {
	 			console.log('child process errored with code ' + code);
				result.exitcode = code
				reject(result)
	 			//file.end();
	 		});
		 })
	}

	async PDFImages(filepath, outpath, options) {

		if(!options) {
			options = {
				allFiles: true
			}
		}
		const poppler = new Poppler('/usr/bin/');
		console.log(outpath)
		await poppler.pdfImages(filepath, outpath + '/page', options)
		// then OCR those toImages

		// create new PDF
	}


	async PDFToText(filepath, outpath, options) {
		if(!options) {
			options = {
			}
		}
		const poppler = new Poppler('/usr/bin/');
		await poppler.pdfToText(filepath, outpath + '/text.txt', options);

	}

	async getArchive(file_id, ctx) {
		var filename = this.getFilenameFromFileID(file_id)
		const input_path = path.join(ROOT, file_id)
		console.log(path.join(input_path, `${filename}.zip`))
		const src = fs.createReadStream(path.join(input_path, `${filename}.zip`));
		ctx.attachment(`${filename}.zip`)
        ctx.response.set("content-type", "application/octet-stream");
        ctx.response.body = src;
		src.pipe(ctx.res);

		var end = new Promise(function(resolve, reject) {
		    src.on('close', () => { console.log('finish'); resolve()});
		    src.on('error', reject);
		});

		return end

	}

	async createArchive(file_id, ctx) {
		const archiver = require('archiver');
		var filename = this.getFilenameFromFileID(file_id)
		const input_path = path.join(ROOT, file_id)
		const output = fs.createWriteStream(path.join(input_path, filename + '.zip'), {flags:'w'});
		const archive = archiver('zip', {
		  zlib: { level: 0 } // Do not compress, images compresses badly.
		});
		archive.pipe(output);
		var end = new Promise(function(resolve, reject) {
			output.on('finish', async () => {
				console.log('done')
				resolve({file: filename + '.zip', fetch:`/api/uploads/${file_id}/zip`});
			})
			output.on('close', async () => {
				console.log('done')
				resolve('close');
			})
			output.on('error', reject);
			archive.on('error', reject);
		});

		archive.file(path.join(input_path, filename), {name: filename})
		archive.directory(path.join(input_path, 'extracted'), 'extracted');
		archive.directory(path.join(input_path, 'rendered'), 'rendered');
		archive.finalize()

		return end;
	}

	async initialUpload(file, with_date) {
		var sanitize = require("sanitize-filename");
		const filename_clean = sanitize(file.name)
		//const file_id = uuid()
		try {
			const file_id = this.createFileID(filename_clean, with_date)
			console.log(file_id)
			await fsp.mkdir(path.join(ROOT, file_id))
			const target_path = path.join(ROOT, file_id, filename_clean)

			await fsp.rename(file.path, target_path)
			return {file_id: file_id, path: target_path}
		} catch (e) {
			await fsp.unlink(file.path) // remove uploaded file
			throw(e)
		}
	}


	async downloadFile(fileUrl) {
		const file_id = uuid()
		const writer = fs.createWriteStream(path.join(ROOT, file_id));
		return new Promise(function(resolve, reject) {
			axios({
				method: 'get',
				url: fileUrl,
				responseType: 'stream',
			}).then(async response => {
				response.data.pipe(writer);
				resolve({'file_id':file_id})
				//return finished(writer); //this is a Promise
			});
		});

	}

	async removeUpload(file_id) {
		fs.rmdirSync(path.join(ROOT, file_id), { recursive: true });
	}

	getFilenameFromFileID(file_id) {
		return file_id.split('-')[0]
	}

	async getFileList(input_path, fullpath) {
		var files = await fsp.readdir(input_path, { withFileTypes: true })
		return files
			.filter(dirent => dirent.isFile())
        	.map(dirent => dirent.name)
			.filter(f => ['.png','.jpg'].includes(path.extname(f)))
			.map(x => path.join(fullpath, x))
	}

	async getDirList(input_path) {
		var files = await fsp.readdir(path.join(ROOT, input_path), { withFileTypes: true })
		return files
			.filter(dirent => !dirent.isFile())
        	.map(dirent => dirent.name)
	}

	async * getTextPdfDirs(dir) {
		const dirents = await fsp.readdir(dir, { withFileTypes: true });
		for (const dirent of dirents) {
			//console.log(dir)
			//console.log(dirent.name)
			const res = path.join(dir, dirent.name);
			if (dirent.isDirectory()) {
				if(res.includes('tesseract/textpdf')) yield res;
				else yield* this.getTextPdfDirs(res);
			}
		}
	}

	async exists (path) {
		try {
			await fsp.access(path)
			return true
		} catch {
			return false
		}
	}

	createFileID(filename, with_date) {
		if(!with_date) return filename
		function pad2(n) { return n < 10 ? '0' + n : n }
		var date = new Date();
		var t = date.getFullYear().toString() +'_'+ pad2(date.getMonth() + 1) +'_'+ pad2( date.getDate()) +'_'+ pad2( date.getHours() ) + pad2( date.getMinutes() ) + pad2( date.getSeconds() )
		return filename + '-' + t
	}

}

function isEntryPoint() {
  return require.main === module;
}

module.exports = PDFSense;
