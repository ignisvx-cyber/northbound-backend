import {json,options} from '../lib/http.js';
export default async function handler(req,res){ if(options(req,res))return; json(res,200,{ok:true,service:'northbound-backend',geminiConfigured:Boolean(process.env.GEMINI_API_KEY),githubConfigured:Boolean(process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET)}); }
